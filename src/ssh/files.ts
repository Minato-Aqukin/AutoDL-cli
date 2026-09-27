import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import { basename, dirname, join, parse, posix, resolve } from "node:path";
import type { Readable } from "node:stream";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Attributes, Client, FileEntryWithStats, SFTPWrapper, Stats } from "ssh2";
import { z } from "zod";
import { configDir } from "../config/store.js";
import type { AutoDLClient } from "../core/client.js";
import { AutoDLError } from "../core/errors.js";
import { assertNotAborted, connectSSH } from "./credentials.js";
import type {
  FileEntry,
  FileSide,
  FileTransferCallbacks,
  FileTransferRequest,
  FileTransferResult,
} from "./file-types.js";

interface Info {
  kind: FileEntry["kind"];
  size: number;
  mtime: number;
}
interface NamedInfo extends Info {
  name: string;
}
interface FileIO {
  stat(path: string): Promise<Info | null>;
  entries(path: string): Promise<NamedInfo[]>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string, overwrite: boolean): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  times(path: string, mtime: number): Promise<void>;
  read(path: string, start?: number, end?: number): Readable;
  write(path: string, start: number, resume: boolean): Writable;
}

function missing(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err.code === "ENOENT" || err.code === 2)
  );
}
function interrupted(): Error {
  return Object.assign(new Error("SSH transport disconnected"), { code: "ECONNRESET" });
}
function kind(stats: {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
}): Info["kind"] {
  return stats.isSymbolicLink()
    ? "symlink"
    : stats.isDirectory()
      ? "directory"
      : stats.isFile()
        ? "file"
        : "other";
}
function kindFromMode(mode: number): Info["kind"] {
  // SFTP file-type bits, same layout as POSIX st_mode.
  const fileType = mode & 0o170000;
  if (fileType === 0o120000) return "symlink";
  if (fileType === 0o040000) return "directory";
  if (fileType === 0o100000) return "file";
  return "other";
}
function fromAttrs(attrs: Attributes): Info {
  return {
    kind: kindFromMode(attrs.mode),
    size: attrs.size,
    mtime: attrs.mtime * 1000,
  };
}
const localIO: FileIO = {
  async stat(path) {
    try {
      const s = await fs.lstat(path);
      return { kind: kind(s), size: s.size, mtime: s.mtimeMs };
    } catch (err) {
      if (missing(err)) return null;
      throw err;
    }
  },
  async entries(path) {
    const names = await fs.readdir(path, { withFileTypes: true });
    const out: NamedInfo[] = [];
    for (const entry of names) {
      if (entry.name === "." || entry.name === "..") continue;
      if (entry.isSymbolicLink())
        out.push({ name: entry.name, kind: "symlink", size: 0, mtime: 0 });
      else if (entry.isDirectory())
        out.push({ name: entry.name, kind: "directory", size: 0, mtime: 0 });
      else if (entry.isFile()) {
        const s = await fs.lstat(join(path, entry.name));
        out.push({ name: entry.name, kind: "file", size: s.size, mtime: s.mtimeMs });
      } else out.push({ name: entry.name, kind: "other", size: 0, mtime: 0 });
    }
    return out;
  },
  async mkdir(path) {
    await fs.mkdir(path);
  },
  async rename(from, to, overwrite) {
    if (overwrite) await fs.rename(from, to);
    else {
      const s = await fs.lstat(from);
      if (s.isFile()) {
        await fs.link(from, to);
        await fs.unlink(from);
      } else {
        if (await localIO.stat(to)) throw new Error(`目标已存在：${to}`);
        await fs.rename(from, to);
      }
    }
  },
  unlink: (path) => fs.unlink(path),
  rmdir: (path) => fs.rmdir(path),
  async times(path, mtime) {
    await fs.utimes(path, mtime / 1000, mtime / 1000);
  },
  read: (path, start = 0, end) =>
    createReadStream(path, { start, ...(end === undefined ? {} : { end }) }),
  write: (path, start, resume) =>
    createWriteStream(path, { flags: resume ? "r+" : "wx", start, mode: 0o600 }),
};

/** SFTP callbacks and streams must settle when the transport disappears. */
class RemoteIO implements FileIO {
  private failure: Error | null = null;
  private readonly pending = new Set<(err: Error) => void>();
  private readonly streams = new Set<Readable | Writable>();
  private readonly onClose = () => this.fail(interrupted());
  private readonly onError = (err: Error) => this.fail(err);
  private readonly onAbort = () => this.fail(new AutoDLError("操作已取消"));
  constructor(
    private readonly conn: Client,
    private readonly sftp: SFTPWrapper,
    private readonly signal?: AbortSignal,
  ) {
    conn.on("close", this.onClose);
    conn.on("error", this.onError);
    sftp.on("close", this.onClose);
    sftp.on("error", this.onError);
    signal?.addEventListener("abort", this.onAbort, { once: true });
  }
  private fail(err: Error): void {
    this.failure ??= err;
    for (const reject of this.pending) reject(err);
    for (const stream of this.streams) stream.destroy(err);
  }
  close(): void {
    this.signal?.removeEventListener("abort", this.onAbort);
    this.conn.off("close", this.onClose);
    this.conn.off("error", this.onError);
    this.sftp.off("close", this.onClose);
    this.sftp.off("error", this.onError);
    this.sftp.end();
  }
  private call<T>(
    start: (callback: (err: Error | undefined | null, value: T) => void) => void,
  ): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.signal?.aborted) return Promise.reject(new AutoDLError("操作已取消"));
    const { promise, resolve: done, reject } = Promise.withResolvers<T>();
    const fail = (err: Error) => {
      this.pending.delete(fail);
      reject(err);
    };
    this.pending.add(fail);
    try {
      start((err, value) => {
        this.pending.delete(fail);
        if (err) reject(err);
        else done(value);
      });
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
    return promise;
  }
  async stat(path: string): Promise<Info | null> {
    try {
      const stats = await this.call<Stats>((cb) => this.sftp.lstat(path, cb));
      return { kind: kind(stats), size: stats.size, mtime: stats.mtime * 1000 };
    } catch (err) {
      if (missing(err)) return null;
      throw err;
    }
  }
  async entries(path: string): Promise<NamedInfo[]> {
    // readdir already ships per-entry attrs: one round trip, no per-file lstat.
    const list = await this.call<FileEntryWithStats[]>((cb) => this.sftp.readdir(path, cb));
    return list
      .filter((entry) => entry.filename !== "." && entry.filename !== "..")
      .map((entry) => ({ name: entry.filename, ...fromAttrs(entry.attrs) }));
  }
  async mkdir(path: string): Promise<void> {
    await this.call<void>((cb) => this.sftp.mkdir(path, (err) => cb(err, undefined)));
  }
  async rename(from: string, to: string, overwrite: boolean): Promise<void> {
    await this.call<void>((cb) => {
      if (overwrite) this.sftp.ext_openssh_rename(from, to, (err) => cb(err, undefined));
      else this.sftp.rename(from, to, (err) => cb(err, undefined));
    });
  }
  async unlink(path: string): Promise<void> {
    await this.call<void>((cb) => this.sftp.unlink(path, (err) => cb(err, undefined)));
  }
  async rmdir(path: string): Promise<void> {
    await this.call<void>((cb) => this.sftp.rmdir(path, (err) => cb(err, undefined)));
  }
  async times(path: string, mtime: number): Promise<void> {
    await this.call<void>((cb) =>
      this.sftp.utimes(path, mtime / 1000, mtime / 1000, (err) => cb(err, undefined)),
    );
  }
  private track<T extends Readable | Writable>(stream: T): T {
    this.streams.add(stream);
    stream.on("error", this.onError);
    stream.once("close", () => this.streams.delete(stream));
    if (this.failure) queueMicrotask(() => stream.destroy(this.failure ?? interrupted()));
    return stream;
  }
  read(path: string, start = 0, end?: number): Readable {
    return this.track(
      this.sftp.createReadStream(path, { start, ...(end === undefined ? {} : { end }) }),
    );
  }
  write(path: string, start: number, resume: boolean): Writable {
    return this.track(
      this.sftp.createWriteStream(path, { flags: resume ? "r+" : "wx", start, mode: 0o600 }),
    );
  }
}

async function openSftp(
  client: AutoDLClient,
  uuid: string,
  signal?: AbortSignal,
): Promise<{ conn: Client; io: RemoteIO }> {
  const conn = await connectSSH(client, uuid, {
    ...(signal ? { signal } : {}),
    connectAttempts: 1,
  });
  assertNotAborted(signal);
  const { promise, resolve: done, reject } = Promise.withResolvers<SFTPWrapper>();
  const lost = () => reject(interrupted());
  const abort = () => {
    reject(new AutoDLError("操作已取消"));
    conn.end();
  };
  conn.once("close", lost);
  conn.once("error", reject);
  signal?.addEventListener("abort", abort, { once: true });
  conn.sftp((err, handle) => {
    if (err) reject(err);
    else done(handle);
  });
  try {
    const handle = await promise;
    const io = new RemoteIO(conn, handle, signal);
    assertNotAborted(signal);
    return { conn, io };
  } catch (err) {
    conn.off("close", lost);
    conn.off("error", reject);
    signal?.removeEventListener("abort", abort);
    conn.end();
    throw err;
  }
}

async function remote<T>(
  client: AutoDLClient,
  uuid: string,
  fn: (io: RemoteIO) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const { conn, io } = await openSftp(client, uuid, signal);
  try {
    return await fn(io);
  } finally {
    io.close();
    conn.end();
  }
}

function fullPath(side: FileSide, path: string): string {
  if (!path.trim() || path.includes("\0")) throw new Error("路径不能为空或包含 NUL");
  return side === "local" ? resolve(path) : posix.resolve("/", path);
}
function safeName(name: string, local: boolean): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\0") ||
    (local &&
      process.platform === "win32" &&
      (/[\\:<>"|?*]/.test(name) ||
        /[ .]$/.test(name) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)))
  ) {
    throw new Error(`不安全或当前平台不支持的文件名：${JSON.stringify(name)}`);
  }
}
async function ensureDir(
  io: FileIO,
  path: string,
  parent: (path: string) => string,
): Promise<void> {
  const info = await io.stat(path);
  if (info) {
    if (info.kind !== "directory") throw new Error(`目标不是普通目录（不跟随符号链接）：${path}`);
    return;
  }
  const up = parent(path);
  if (up === path) throw new Error(`目录不可访问：${path}`);
  await ensureDir(io, up, parent);
  try {
    await io.mkdir(path);
  } catch (err) {
    if ((await io.stat(path))?.kind !== "directory") throw err;
  }
}
async function digest(
  io: FileIO,
  path: string,
  signal: AbortSignal,
  end?: number,
): Promise<string> {
  assertNotAborted(signal);
  const hash = createHash("sha256");
  await pipeline(
    io.read(path, 0, end),
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        done();
      },
    }),
    { signal },
  );
  return hash.digest("hex");
}
function sameVersion(a: Info | null, b: Info | null): boolean {
  return a?.kind === b?.kind && a?.size === b?.size && a?.mtime === b?.mtime;
}
const CheckpointSchema = z.object({
  version: z.literal(1),
  key: z.string(),
  choice: z.enum(["overwrite", "skip", "keep-both"]).optional(),
  files: z.record(
    z.object({ size: z.number(), mtime: z.number(), target: z.string(), complete: z.boolean() }),
  ),
});
type Checkpoint = z.infer<typeof CheckpointSchema>;
interface PlannedFile {
  source: string;
  target: string;
  info: Info;
}

/** Local filesystem plus one reusable authenticated SFTP connection. */
export class FileWorkspace {
  private session: { conn: Client; io: RemoteIO } | null = null;
  private connecting: Promise<{ conn: Client; io: RemoteIO }> | null = null;
  private disposed = false;
  constructor(
    private readonly client: AutoDLClient,
    private readonly uuid: string,
  ) {}
  private use<T>(side: FileSide, fn: (io: FileIO) => Promise<T>): Promise<T> {
    if (side === "local") return fn(localIO);
    return this.withSession((io) => fn(io));
  }
  /**
   * One SFTP connection for all short browsing operations. Directory contents
   * are still read live on every call — only the TCP handshake and SSH
   * authentication are reused. A dead connection is dropped and the next
   * operation reconnects transparently. Long transfers keep their own
   * connection so browsing and transfers never block each other.
   */
  private async withSession<T>(fn: (io: RemoteIO) => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error("文件会话已关闭");
    const live = this.session ?? (await this.connect());
    try {
      return await fn(live.io);
    } catch (err) {
      this.drop(live);
      throw err;
    }
  }
  private async connect(): Promise<{ conn: Client; io: RemoteIO }> {
    if (this.session) return this.session;
    this.connecting ??= openSftp(this.client, this.uuid).then(
      (session) => {
        this.session = session;
        this.connecting = null;
        session.conn.once("close", () => this.drop(session));
        return session;
      },
      (err: unknown) => {
        this.connecting = null;
        throw err;
      },
    );
    return this.connecting;
  }
  private drop(session: { conn: Client; io: RemoteIO }): void {
    if (this.session !== session) return;
    this.session = null;
    try {
      session.io.close();
    } catch {
      // Already dead; the next operation reconnects.
    }
    try {
      session.conn.end();
    } catch {
      // Already dead; the next operation reconnects.
    }
  }
  /** Release the browsing connection; safe to call more than once. */
  dispose(): void {
    this.disposed = true;
    this.connecting = null;
    const session = this.session;
    this.session = null;
    if (!session) return;
    try {
      session.io.close();
    } catch {
      // Teardown is best effort.
    }
    try {
      session.conn.end();
    } catch {
      // Teardown is best effort.
    }
  }
  async list(side: FileSide, path: string): Promise<FileEntry[]> {
    const root = fullPath(side, path);
    const paths = side === "local" ? { join } : posix;
    return this.use(side, async (io) => {
      if ((await io.stat(root))?.kind !== "directory") throw new Error(`不是普通目录：${root}`);
      // Current directory only: readdir entries carry their own attrs, no recursion
      // and no per-file stat round trip.
      const entries: FileEntry[] = [];
      for (const item of await io.entries(root)) {
        safeName(item.name, side === "local");
        const { name, ...info } = item;
        entries.push({ name, path: paths.join(root, name), ...info });
      }
      return entries.sort(
        (a, b) =>
          Number(b.kind === "directory") - Number(a.kind === "directory") ||
          a.name.localeCompare(b.name),
      );
    });
  }
  async mkdir(side: FileSide, path: string): Promise<void> {
    await this.use(side, (io) =>
      ensureDir(io, fullPath(side, path), side === "local" ? dirname : posix.dirname),
    );
  }
  async rename(side: FileSide, from: string, to: string): Promise<void> {
    const source = fullPath(side, from),
      target = fullPath(side, to);
    if (source === target) return;
    const root = side === "local" ? parse(source).root : "/";
    if (source === root) throw new Error("不能移动文件系统根目录");
    await this.use(side, async (io) => {
      if (await io.stat(target)) throw new Error(`目标已存在，未覆盖：${target}`);
      await io.rename(source, target, false);
    });
  }
  async remove(side: FileSide, path: string): Promise<void> {
    if (path === "." || path === "..") throw new Error("不能删除当前位置或父目录");
    const root = fullPath(side, path);
    if (root === (side === "local" ? parse(root).root : "/"))
      throw new Error("不能删除文件系统根目录");
    await this.use(side, async (io) => {
      const walk = async (current: string): Promise<void> => {
        const info = await io.stat(current);
        if (!info) throw new Error(`路径不存在：${current}`);
        if (info.kind === "directory") {
          for (const item of await io.entries(current)) {
            safeName(item.name, side === "local");
            await walk(
              side === "local" ? join(current, item.name) : posix.join(current, item.name),
            );
          }
          await io.rmdir(current);
        } else await io.unlink(current);
      };
      await walk(root);
    });
  }

  async transfer(
    request: FileTransferRequest,
    callbacks: FileTransferCallbacks,
    signal: AbortSignal,
  ): Promise<FileTransferResult> {
    if (
      request.uuid !== this.uuid ||
      !/^[\da-f-]{36}$/i.test(request.id) ||
      !request.sources.length
    )
      throw new Error("传输任务标识或来源无效");
    assertNotAborted(signal);
    const upload = request.direction === "upload";
    const sourcePaths = upload ? { join, dirname, basename } : posix;
    const targetPaths = upload ? posix : { join, dirname, basename };
    const destination = fullPath(upload ? "remote" : "local", request.destination);
    const sources = request.sources.map((p) => fullPath(upload ? "local" : "remote", p));
    const key = createHash("sha256")
      .update(
        JSON.stringify([this.uuid, upload, sources, destination, request.sync, request.checksum]),
      )
      .digest("hex");
    const metadataDir = join(configDir(), "transfers", "partials");
    const metadataPath = join(metadataDir, `${request.id}.json`);
    let checkpoint: Checkpoint = { version: 1, key, files: {} };
    try {
      checkpoint = CheckpointSchema.parse(JSON.parse(await fs.readFile(metadataPath, "utf8")));
    } catch (err) {
      if (!missing(err)) throw new Error(`续传记录不可读取：${metadataPath}`, { cause: err });
    }
    if (checkpoint.key !== key) throw new Error("续传任务路径或选项已改变，请创建新任务");
    const save = async () => {
      await fs.mkdir(metadataDir, { recursive: true, mode: 0o700 });
      const temporary = `${metadataPath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(checkpoint), { mode: 0o600 });
      await fs.rename(temporary, metadataPath);
    };
    await save();
    return remote(
      this.client,
      this.uuid,
      async (remoteIO) => {
        const source = upload ? localIO : remoteIO;
        const target = upload ? remoteIO : localIO;
        const files: PlannedFile[] = [];
        const directories: string[] = [];
        const skipped: string[] = [];
        const destinations = new Set<string>();
        const walk = async (from: string, to: string): Promise<void> => {
          assertNotAborted(signal);
          if (destinations.has(to)) throw new Error(`多个来源映射到同一目标：${to}`);
          destinations.add(to);
          const info = await source.stat(from);
          if (!info) throw new Error(`来源不存在：${from}`);
          if (info.kind === "symlink" || info.kind === "other") {
            skipped.push(from);
            return;
          }
          if (info.kind === "directory") {
            directories.push(to);
            for (const item of await source.entries(from)) {
              safeName(item.name, !upload);
              await walk(sourcePaths.join(from, item.name), targetPaths.join(to, item.name));
            }
          } else files.push({ source: from, target: to, info });
        };
        for (const path of sources) {
          const name = sourcePaths.basename(path);
          safeName(name, !upload);
          await walk(path, targetPaths.join(destination, name));
        }
        await ensureDir(target, destination, targetPaths.dirname);
        for (const dir of directories) {
          assertNotAborted(signal);
          await ensureDir(target, dir, targetPaths.dirname);
        }
        const total = files.reduce((sum, file) => sum + file.info.size, 0);
        let transferred = 0,
          filesDone = 0,
          copied = 0,
          bytes = 0,
          sessionBytes = 0;
        const started = Date.now();
        const progress = (file: string) =>
          callbacks.onProgress({
            file,
            transferred,
            total,
            filesDone,
            filesTotal: files.length,
            bytesPerSecond: (sessionBytes * 1000) / Math.max(1, Date.now() - started),
          });
        for (const file of files) {
          assertNotAborted(signal);
          const id = createHash("sha256")
            .update(JSON.stringify([file.source, file.target]))
            .digest("hex");
          let saved = checkpoint.files[id];
          let output = file.target;
          if (
            saved &&
            (targetPaths.dirname(saved.target) !== targetPaths.dirname(output) ||
              !targetPaths.basename(saved.target).startsWith(targetPaths.basename(output)))
          )
            throw new Error("续传目标不在原任务目录内");
          if (saved) output = saved.target;
          let existing = await target.stat(output);
          if (existing && existing.kind !== "file")
            throw new Error(`目标不是普通文件，未覆盖：${output}`);
          const unchanged =
            existing?.size === file.info.size &&
            Math.floor(existing.mtime / 1000) === Math.floor(file.info.mtime / 1000);
          let equal = unchanged;
          if (existing && request.checksum && (request.sync || saved?.complete))
            equal =
              existing.size === file.info.size &&
              (await digest(source, file.source, signal)) ===
                (await digest(target, output, signal));
          if (
            (request.sync ||
              (saved?.complete &&
                saved.size === file.info.size &&
                saved.mtime === file.info.mtime)) &&
            equal
          ) {
            transferred += file.info.size;
            filesDone++;
            skipped.push(file.source);
            progress(file.source);
            continue;
          }
          if (!request.sync && existing && !saved) {
            const resolution = checkpoint.choice
              ? { choice: checkpoint.choice, applyToAll: true }
              : await callbacks.onConflict({
                  source: file.source,
                  destination: output,
                  sourceSize: file.info.size,
                  destinationSize: existing.size,
                });
            assertNotAborted(signal);
            if (resolution.applyToAll) {
              checkpoint.choice = resolution.choice;
              await save();
            }
            if (resolution.choice === "skip") {
              skipped.push(file.source);
              transferred += file.info.size;
              filesDone++;
              progress(file.source);
              continue;
            }
            if (resolution.choice === "keep-both") {
              let n = 1;
              while (await target.stat(`${file.target} (${n})`)) n++;
              output = `${file.target} (${n})`;
              existing = null;
            }
          }
          const temporary = targetPaths.join(
            targetPaths.dirname(output),
            `.autodl-${request.id}-${id.slice(0, 16)}.part`,
          );
          await ensureDir(target, targetPaths.dirname(output), targetPaths.dirname);
          let partial = await target.stat(temporary);
          if (partial && partial.kind !== "file")
            throw new Error(`续传临时路径不是普通文件：${temporary}`);
          const versionMatches = saved?.size === file.info.size && saved.mtime === file.info.mtime;
          let offset = versionMatches && partial ? partial.size : 0;
          if (offset > file.info.size) offset = 0;
          if (
            offset > 0 &&
            (await digest(source, file.source, signal, offset - 1)) !==
              (await digest(target, temporary, signal, offset - 1))
          )
            offset = 0;
          if (partial && offset === 0) {
            await target.unlink(temporary);
            partial = null;
          }
          checkpoint.files[id] = {
            size: file.info.size,
            mtime: file.info.mtime,
            target: output,
            complete: false,
          };
          saved = checkpoint.files[id];
          await save();
          transferred += offset;
          progress(file.source);
          if (offset < file.info.size || !partial) {
            const meter = new Transform({
              transform(chunk: Buffer, _encoding, done) {
                transferred += chunk.length;
                sessionBytes += chunk.length;
                progress(file.source);
                done(null, chunk);
              },
            });
            await pipeline(
              source.read(file.source, offset),
              meter,
              target.write(temporary, offset, Boolean(partial)),
              { signal },
            );
          }
          assertNotAborted(signal);
          if (!sameVersion(await source.stat(file.source), file.info))
            throw new Error(`来源在传输中发生变化，未覆盖目标：${file.source}`);
          if (!sameVersion(await target.stat(output), existing))
            throw new Error(`目标在传输中发生变化，未覆盖：${output}`);
          await target.times(temporary, file.info.mtime);
          await target.rename(temporary, output, Boolean(existing));
          saved.complete = true;
          await save();
          copied++;
          bytes += file.info.size;
          filesDone++;
          progress(file.source);
        }
        return { files: copied, bytes, skipped };
      },
      signal,
    );
  }
}
