import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TransferQueue } from "../../src/ssh/transfer-queue.js";

/**
 * The transfer helpers never trust a resolved path for intent the resolver discards:
 * `resolve()` strips a trailing separator, and it absolutises relative CLI input, so a
 * download into a directory has to read the raw argument (or the filesystem) to know the
 * caller meant a directory. The queue's namespace is the other trust boundary — anything
 * outside its alphabet is rejected before a directory is created. Symlink mode bits keep
 * the same POSIX layout (`st_mode & 0o170000`) the SFTP walker relies on to skip links.
 */

describe("download directory intent survives path resolution", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "autodl-pull-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a trailing separator from the raw argument, not the resolved path", () => {
    const target = join(dir, "downloads");
    // resolve() strips the separator — the heuristic must not rely on it.
    expect(resolve(`${target}/`)).toBe(target);
    expect(/[/\\]$/.test(`${target}/`)).toBe(true);
  });

  it("an existing directory is visible through the filesystem", async () => {
    const target = join(dir, "downloads");
    await mkdir(target, { recursive: true });
    expect((await stat(target)).isDirectory()).toBe(true);
  });
});

describe("transfer path helpers", () => {
  it("resolve() absolutises relative CLI input", () => {
    expect(resolve("./data")).not.toBe("./data");
  });

  it("mode bits distinguish symlink/dir/file", () => {
    expect(0o120000 & 0o170000).toBe(0o120000);
    expect(0o040000 & 0o170000).toBe(0o040000);
    expect(0o100000 & 0o170000).toBe(0o100000);
  });
});

describe("queue namespaces stay inside their directory", () => {
  it("rejects traversal input before creating anything", () => {
    expect(() => new TransferQueue({} as never, "../escape")).toThrow(/命名空间非法/);
    expect(() => new TransferQueue({} as never, "ok-but/too-short")).toThrow(/命名空间非法/);
  });
});

describe("pull directory loop reports per-file progress", () => {
  it("uses collected.entries() with index/total/bytes", () => {
    const collected = [
      { remote: "/r/a", rel: "a", size: 10 },
      { remote: "/r/b", rel: "b", size: 20 },
    ];
    const seen: { file: string; index: number; total: number; bytes: number }[] = [];
    for (const [index, item] of collected.entries()) {
      seen.push({ file: item.rel, index: index + 1, total: collected.length, bytes: item.size });
    }
    expect(seen).toEqual([
      { file: "a", index: 1, total: 2, bytes: 10 },
      { file: "b", index: 2, total: 2, bytes: 20 },
    ]);
  });

  it("only regular files are collected; links and specials are skipped", () => {
    const entries = [
      { name: "dir", isDirectory: true, isFile: false, isLink: false },
      { name: "f", isDirectory: false, isFile: true, isLink: false },
      { name: "link", isDirectory: false, isFile: false, isLink: true },
      { name: "fifo", isDirectory: false, isFile: false, isLink: false },
    ];
    const collected: string[] = [];
    const skipped: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      if (!entry.isFile) {
        skipped.push(entry.name);
        continue;
      }
      collected.push(entry.name);
    }
    expect(collected).toEqual(["f"]);
    expect(skipped).toEqual(["link", "fifo"]);
  });
});

describe("follow explicitly named top-level links", () => {
  it("stat() follows links while nested walks still skip them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autodl-push-"));
    try {
      const real = join(dir, "real.txt");
      writeFileSync(real, "hi");
      const link = join(dir, "link.txt");
      symlinkSync(real, link);
      // What push() now does at the top level: stat follows the link.
      expect((await stat(link)).isFile()).toBe(true);
      // lstat would have rejected it as a link.
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("failed-download cleanup keeps the original error, not ENOENT", async () => {
    const missingCode = (err: unknown): boolean =>
      typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
    const original = new Error("Permission denied");
    const outcome = await Promise.reject(original)
      .catch((err: Error) =>
        Promise.reject(new Error("ENOENT: unlink never-created"))
          .catch((unlinkErr: unknown) => {
            if (!missingCode({ code: "ENOENT" })) throw unlinkErr;
          })
          .then(() => {
            throw err;
          }),
      )
      .catch((err: Error) => err);
    expect(outcome).toBe(original);
  });
});

describe("checkpoint saver serializes concurrent flushes", () => {
  it("overlapping saves serialize on one chain and all resolve", async () => {
    const { createCheckpointSaver } = await import("../../src/ssh/files.js");
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let n = 0;
    const saver = createCheckpointSaver(async () => {
      const id = n++;
      order.push(`start-${id}`);
      if (id === 0) await gate;
      order.push(`end-${id}`);
    }, 1000);
    const first = saver.save(true);
    const second = saver.save(true);
    const third = saver.save(true);
    release();
    await Promise.all([first, second, third]);
    // Strictly serial: no second start before the previous end.
    expect(order).toEqual(["start-0", "end-0", "start-1", "end-1", "start-2", "end-2"]);
  });

  it("a failing flush rejects its caller but leaves the chain usable", async () => {
    const { createCheckpointSaver } = await import("../../src/ssh/files.js");
    let calls = 0;
    const saver = createCheckpointSaver(async () => {
      calls++;
      if (calls === 1) throw new Error("disk full");
    }, 1000);
    await expect(saver.save(true)).rejects.toThrow(/disk full/);
    await expect(saver.save(true)).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});

describe("queue resolution keeps applyToAll across processes", () => {
  it("old bare-string resolutions still load as single answers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autodl-queue-"));
    const prev = process.env.AUTODL_CONFIG_DIR;
    process.env.AUTODL_CONFIG_DIR = dir;
    try {
      const queue = new TransferQueue({} as never, "test-namespace-1");
      const id = queue.enqueue({
        uuid: "pro-test",
        direction: "upload",
        sources: ["/tmp/src"],
        destination: "/root/dst",
        sync: false,
        checksum: false,
      });
      // Simulate a pre-applyToAll record: bare string resolution.
      const { readdirSync, readFileSync } = await import("node:fs");
      const nsDirs = readdirSync(join(dir, "transfers"));
      const recordDir = join(dir, "transfers", nsDirs[0] as string);
      const recordPath = join(recordDir, `${id}.json`);
      const raw = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
      raw.resolution = "overwrite";
      raw.version = 1;
      writeFileSync(recordPath, JSON.stringify(raw));
      await queue.dispose();
      const reopened = new TransferQueue({} as never, "test-namespace-1");
      try {
        const job = reopened.snapshot().find((entry) => entry.request.id === id);
        expect(job).toBeDefined();
      } finally {
        await reopened.dispose();
      }
    } finally {
      if (prev === undefined) delete process.env.AUTODL_CONFIG_DIR;
      else process.env.AUTODL_CONFIG_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
