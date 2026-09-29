import { mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, posix, relative, resolve as resolvePath, sep } from "node:path";
import type { Client, SFTPWrapper } from "ssh2";
import type { AutoDLClient } from "../core/client.js";
import { AutoDLError, SSHError } from "../core/errors.js";
import { debug } from "../output/format.js";
import { assertNotAborted, type ConnectOptions, withSSH } from "./credentials.js";

export interface TransferProgress {
  file: string;
  index: number;
  total: number;
  bytes: number;
}

export interface TransferOptions extends ConnectOptions {
  /** Glob-ish ignore patterns; `.autodlignore` then `.gitignore` are used by default. */
  ignore?: string[];
  onProgress?: (progress: TransferProgress) => void;
  /** Skip reading ignore files from disk (used by tests and explicit single-file copies). */
  noIgnoreFiles?: boolean;
}

/** Directories that are never worth shipping to a GPU box. */
const ALWAYS_IGNORE = [
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  ".mypy_cache",
  ".pytest_cache",
  ".DS_Store",
  "*.pyc",
];

function sftp(conn: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    conn.sftp((err, handle) => {
      if (err) reject(new SSHError(`SFTP 通道建立失败：${err.message}`, { cause: err }));
      else resolve(handle);
    });
  });
}

/**
 * Translate one ignore line into a matcher.
 *
 * Deliberately a small subset of gitignore semantics — `*`, `?`, leading `/` anchoring
 * and trailing `/` for directories. Anything fancier is better handled by the user
 * passing explicit paths.
 */
function toMatcher(pattern: string): (relPath: string) => boolean {
  const trimmed = pattern.trim();
  const anchored = trimmed.startsWith("/");
  const body = (anchored ? trimmed.slice(1) : trimmed).replace(/\/$/, "");
  const escaped = body
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  const regex = new RegExp(anchored ? `^${escaped}(/|$)` : `(^|/)${escaped}(/|$)`);
  return (relPath: string) => regex.test(relPath);
}

async function loadIgnoreFile(root: string, name: string): Promise<string[]> {
  try {
    const content = await readFile(join(root, name), "utf8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"));
  } catch {
    return [];
  }
}

async function buildIgnoreMatcher(
  root: string,
  options: TransferOptions,
): Promise<(relPath: string) => boolean> {
  const patterns = [...ALWAYS_IGNORE, ...(options.ignore ?? [])];
  if (!options.noIgnoreFiles) {
    const fromAutodl = await loadIgnoreFile(root, ".autodlignore");
    patterns.push(...(fromAutodl.length ? fromAutodl : await loadIgnoreFile(root, ".gitignore")));
  }
  const matchers = patterns.map(toMatcher);
  return (relPath: string) => matchers.some((match) => match(relPath));
}

async function collectFiles(
  root: string,
  ignored: (relPath: string) => boolean,
): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const rel = relative(root, absolute).split(sep).join("/");
      if (ignored(rel)) {
        debug(`跳过 ${rel}`);
        continue;
      }
      // Never follow local symlinks: a link loop would recurse forever and a
      // link target outside the root would leak unrelated files.
      if (entry.isSymbolicLink()) {
        debug(`跳过符号链接 ${rel}`);
        continue;
      }
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push(rel);
      else debug(`跳过特殊文件 ${rel}`);
    }
  }
  await walk(root);
  return files;
}

function mkdirRemote(handle: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve) => {
    // EEXIST is the common case on repeat syncs; treat every mkdir failure as benign
    // and let the subsequent write surface a real problem.
    handle.mkdir(path, () => resolve());
  });
}

async function ensureRemoteDir(handle: SFTPWrapper, path: string): Promise<void> {
  const segments = path.split("/").filter(Boolean);
  let current = path.startsWith("/") ? "" : ".";
  for (const segment of segments) {
    current = `${current}/${segment}`;
    await mkdirRemote(handle, current);
  }
}

function fastTransfer(
  run: (
    source: string,
    target: string,
    opts: {
      concurrency?: number;
      chunkSize?: number;
      step?: (total: number, chunk: number, fileSize: number) => void;
    },
    callback: (err: Error | null | undefined) => void,
  ) => void,
  source: string,
  target: string,
  opts: { signal?: AbortSignal; onChunk?: (chunk: number) => void },
): Promise<void> {
  if (opts.signal?.aborted) return Promise.reject(new AutoDLError("操作已取消"));
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let settled = false;
  const done = (err?: Error | null): void => {
    if (settled) return;
    settled = true;
    opts.signal?.removeEventListener("abort", onAbort);
    if (err) reject(err);
    else resolve();
  };
  const onAbort = (): void => {
    done(new AutoDLError("操作已取消"));
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    // 64 x 32 KiB in flight is ssh2's own default; the partial file is
    // removed by the caller so a cancelled transfer never looks complete.
    run(
      source,
      target,
      {
        concurrency: 64,
        chunkSize: 32 * 1024,
        step: (_t, chunk) => {
          opts.onChunk?.(chunk);
        },
      },
      (err) => done(err ?? undefined),
    );
  } catch (err) {
    done(err instanceof Error ? err : new Error(String(err)));
  }
  return promise;
}

function uploadFile(
  handle: SFTPWrapper,
  local: string,
  remote: string,
  opts: { signal?: AbortSignal; onChunk?: (chunk: number) => void } = {},
): Promise<void> {
  return fastTransfer(handle.fastPut.bind(handle), local, remote, opts).catch((err: Error) => {
    const cleanup = new Promise<void>((resolve) => {
      handle.unlink(remote, () => resolve());
    });
    return cleanup.then(() => {
      throw err;
    });
  });
}

function isMissing(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err.code === "ENOENT" || err.code === 2)
  );
}

function downloadFile(
  handle: SFTPWrapper,
  remote: string,
  local: string,
  opts: { signal?: AbortSignal; onChunk?: (chunk: number) => void } = {},
): Promise<void> {
  return fastTransfer(handle.fastGet.bind(handle), remote, local, opts).catch((err: Error) =>
    // fastGet creates the local file only after the remote open succeeds, so
    // a remote failure (or an abort in that window) leaves nothing to delete:
    // swallow ENOENT and rethrow the original error, never the unlink's.
    unlink(local)
      .catch((unlinkErr: unknown) => {
        if (!isMissing(unlinkErr)) throw unlinkErr;
      })
      .then(() => {
        throw err;
      }),
  );
}

function statRemote(handle: SFTPWrapper, path: string) {
  return new Promise<{ isDirectory: boolean; size: number }>((resolve, reject) => {
    handle.stat(path, (err, stats) => {
      if (err) reject(new AutoDLError(`远程路径不可访问：${path}`, { cause: err }));
      else resolve({ isDirectory: stats.isDirectory(), size: stats.size });
    });
  });
}

function readdirRemote(
  handle: SFTPWrapper,
  path: string,
): Promise<
  { name: string; isDirectory: boolean; isFile: boolean; isLink: boolean; size: number }[]
> {
  return new Promise((resolve, reject) => {
    handle.readdir(path, (err, list) => {
      if (err) reject(new AutoDLError(`无法列出远程目录：${path}`, { cause: err }));
      else
        resolve(
          list
            .filter((item) => item.filename !== "." && item.filename !== "..")
            .map((item) => {
              const mode = item.attrs.mode & 0o170000;
              return {
                name: item.filename,
                isDirectory: mode === 0o040000,
                isFile: mode === 0o100000,
                isLink: mode === 0o120000,
                size: item.attrs.size,
              };
            }),
        );
    });
  });
}

export interface TransferSummary {
  files: number;
  bytes: number;
}

/** Upload a local file or directory to the instance. */
export async function push(
  client: AutoDLClient,
  uuid: string,
  localPath: string,
  remotePath: string,
  options: TransferOptions = {},
): Promise<TransferSummary> {
  const local = resolvePath(localPath);
  // Follow an explicitly named top-level link (datasets, HF cache blobs and
  // `run --sync <link>` all legitimately point at links); nested links inside
  // a walked directory are still skipped by collectFiles.
  const info = await stat(local).catch(() => null);
  if (!info) throw new AutoDLError(`本地路径不存在：${localPath}`);
  if (!info.isFile() && !info.isDirectory())
    throw new AutoDLError(`本地路径不是普通文件或目录：${localPath}`);

  return withSSH(
    client,
    uuid,
    async (conn) => {
      const handle = await sftp(conn);
      try {
        if (info.isFile()) {
          const target = remotePath.endsWith("/")
            ? posix.join(remotePath, basename(local))
            : remotePath;
          assertNotAborted(options.signal);
          await ensureRemoteDir(handle, posix.dirname(target));
          await uploadFile(handle, local, target, { signal: options.signal });
          options.onProgress?.({ file: basename(local), index: 1, total: 1, bytes: info.size });
          return { files: 1, bytes: info.size };
        }

        const ignored = await buildIgnoreMatcher(local, options);
        const files = await collectFiles(local, ignored);
        assertNotAborted(options.signal);
        await ensureRemoteDir(handle, remotePath);

        let bytes = 0;
        // Create every directory up front so uploads never race on a missing parent.
        const dirs = new Set(files.map((f) => posix.dirname(f)).filter((d) => d !== "."));
        for (const dir of [...dirs].sort()) {
          assertNotAborted(options.signal);
          await ensureRemoteDir(handle, posix.join(remotePath, dir));
        }
        for (const [index, rel] of files.entries()) {
          assertNotAborted(options.signal);
          const source = join(local, rel);
          const size = (await stat(source)).size;
          await uploadFile(handle, source, posix.join(remotePath, rel), {
            signal: options.signal,
          });
          bytes += size;
          options.onProgress?.({ file: rel, index: index + 1, total: files.length, bytes: size });
        }
        return { files: files.length, bytes };
      } finally {
        handle.end();
      }
    },
    options,
  );
}

/** Download a remote file or directory from the instance. */
export async function pull(
  client: AutoDLClient,
  uuid: string,
  remotePath: string,
  localPath: string,
  options: TransferOptions = {},
): Promise<TransferSummary> {
  // resolve() strips trailing separators, so directory intent must come from the
  // raw argument or the filesystem — never from the resolved path.
  const intoDir =
    /[/\\]$/.test(localPath) ||
    (await stat(resolvePath(localPath)).catch(() => null))?.isDirectory() === true;
  const local = resolvePath(localPath);

  return withSSH(
    client,
    uuid,
    async (conn) => {
      const handle = await sftp(conn);
      try {
        const info = await statRemote(handle, remotePath);
        if (!info.isDirectory) {
          const target = intoDir ? join(local, basename(remotePath)) : local;
          assertNotAborted(options.signal);
          await mkdir(dirname(target), { recursive: true });
          await downloadFile(handle, remotePath, target, { signal: options.signal });
          options.onProgress?.({
            file: basename(remotePath),
            index: 1,
            total: 1,
            bytes: info.size,
          });
          return { files: 1, bytes: info.size };
        }

        // readdir ships per-entry attrs (mode/size): reuse them instead of an
        // extra STAT per file. Only regular files are downloaded; symlinks,
        // FIFOs, sockets and devices are skipped (opening a FIFO would block
        // until a writer appears).
        const collected: { remote: string; rel: string; size: number }[] = [];
        const skippedNames: string[] = [];
        const walk = async (dir: string, prefix: string): Promise<void> => {
          assertNotAborted(options.signal);
          for (const entry of await readdirRemote(handle, dir)) {
            const remote = posix.join(dir, entry.name);
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory) {
              await walk(remote, rel);
              continue;
            }
            if (!entry.isFile) {
              skippedNames.push(`${rel} (special, skipped)`);
              continue;
            }
            collected.push({ remote, rel, size: entry.size });
          }
        };
        await walk(remotePath, "");
        if (skippedNames.length) debug(`跳过 ${skippedNames.length} 个链接/特殊文件`);

        let bytes = 0;
        for (const [index, item] of collected.entries()) {
          assertNotAborted(options.signal);
          const target = join(local, item.rel);
          await mkdir(dirname(target), { recursive: true });
          await downloadFile(handle, item.remote, target, { signal: options.signal });
          bytes += item.size;
          options.onProgress?.({
            file: item.rel,
            index: index + 1,
            total: collected.length,
            bytes: item.size,
          });
        }
        return { files: collected.length, bytes };
      } finally {
        handle.end();
      }
    },
    options,
  );
}
