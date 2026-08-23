import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, posix, relative, resolve as resolvePath, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Client, SFTPWrapper } from "ssh2";
import type { AutoDLClient } from "../core/client.js";
import { AutoDLError, SSHError } from "../core/errors.js";
import { debug } from "../output/format.js";
import { type ConnectOptions, withSSH } from "./credentials.js";

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
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push(rel);
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

function uploadFile(handle: SFTPWrapper, local: string, remote: string): Promise<void> {
  return pipeline(createReadStream(local), handle.createWriteStream(remote));
}

function downloadFile(handle: SFTPWrapper, remote: string, local: string): Promise<void> {
  return pipeline(handle.createReadStream(remote), createWriteStream(local));
}

function statRemote(handle: SFTPWrapper, path: string) {
  return new Promise<{ isDirectory: boolean; size: number }>((resolve, reject) => {
    handle.stat(path, (err, stats) => {
      if (err) reject(new AutoDLError(`远程路径不可访问：${path}`, { cause: err }));
      else resolve({ isDirectory: stats.isDirectory(), size: stats.size });
    });
  });
}

function readdirRemote(handle: SFTPWrapper, path: string) {
  return new Promise<{ name: string; isDirectory: boolean }[]>((resolve, reject) => {
    handle.readdir(path, (err, list) => {
      if (err) reject(new AutoDLError(`无法列出远程目录：${path}`, { cause: err }));
      else
        resolve(
          list.map((item) => ({
            name: item.filename,
            isDirectory: (item.attrs.mode & 0o170000) === 0o040000,
          })),
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
  const info = await stat(local).catch(() => null);
  if (!info) throw new AutoDLError(`本地路径不存在：${localPath}`);

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
          await ensureRemoteDir(handle, posix.dirname(target));
          await uploadFile(handle, local, target);
          options.onProgress?.({ file: basename(local), index: 1, total: 1, bytes: info.size });
          return { files: 1, bytes: info.size };
        }

        const ignored = await buildIgnoreMatcher(local, options);
        const files = await collectFiles(local, ignored);
        await ensureRemoteDir(handle, remotePath);

        let bytes = 0;
        // Create every directory up front so uploads never race on a missing parent.
        const dirs = new Set(files.map((f) => posix.dirname(f)).filter((d) => d !== "."));
        for (const dir of [...dirs].sort()) {
          await ensureRemoteDir(handle, posix.join(remotePath, dir));
        }
        for (const [index, rel] of files.entries()) {
          const source = join(local, rel);
          const size = (await stat(source)).size;
          await uploadFile(handle, source, posix.join(remotePath, rel));
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
  const local = resolvePath(localPath);

  return withSSH(
    client,
    uuid,
    async (conn) => {
      const handle = await sftp(conn);
      try {
        const info = await statRemote(handle, remotePath);
        if (!info.isDirectory) {
          const target = local.endsWith(sep) ? join(local, basename(remotePath)) : local;
          await mkdir(dirname(target), { recursive: true });
          await downloadFile(handle, remotePath, target);
          options.onProgress?.({
            file: basename(remotePath),
            index: 1,
            total: 1,
            bytes: info.size,
          });
          return { files: 1, bytes: info.size };
        }

        const collected: { remote: string; rel: string; size: number }[] = [];
        const walk = async (dir: string, prefix: string): Promise<void> => {
          for (const entry of await readdirRemote(handle, dir)) {
            const remote = posix.join(dir, entry.name);
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory) await walk(remote, rel);
            else collected.push({ remote, rel, size: (await statRemote(handle, remote)).size });
          }
        };
        await walk(remotePath, "");

        let bytes = 0;
        for (const [index, item] of collected.entries()) {
          const target = join(local, item.rel);
          await mkdir(dirname(target), { recursive: true });
          await downloadFile(handle, item.remote, target);
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
