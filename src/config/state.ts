import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./store.js";

/**
 * Local ledger of instances this machine created with a TTL.
 *
 * This is the *second* line of the cost guard. The first one lives inside the instance
 * (`shutdown -h +N` armed via start_command) and keeps working even if this file, this
 * process, or this whole machine goes away. The ledger exists to catch the cases the
 * in-instance timer can't: a start_command that silently failed, or an instance that
 * was powered on again without a fresh timer.
 */

export interface TrackedInstance {
  uuid: string;
  name?: string;
  /** Epoch ms after which the instance should no longer be running. */
  expiresAt: number;
  ttlSeconds: number;
  createdAt: number;
  /** Whether the in-instance shutdown timer was successfully armed. */
  inInstanceTimer: boolean;
}

interface StateFile {
  version: 1;
  tracked: Record<string, TrackedInstance>;
}

const EMPTY: StateFile = { version: 1, tracked: {} };

const statePath = (): string => join(configDir(), "state.json");

function readState(): StateFile {
  const file = statePath();
  if (!existsSync(file)) return { ...EMPTY, tracked: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as StateFile;
    return { version: 1, tracked: parsed.tracked ?? {} };
  } catch {
    return { ...EMPTY, tracked: {} };
  }
}

function writeState(state: StateFile): void {
  const file = statePath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // Atomic replace: a concurrent reader never sees a truncated half-write, and a
  // crash mid-write leaves the previous ledger intact instead of an empty file.
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/**
 * A lock held longer than this is treated as abandoned. The guarded section is one
 * small read + rename, so a live holder finishes in milliseconds; only a process that
 * died mid-update leaves the lock behind.
 */
const LOCK_STALE_MS = 2_000;
const LOCK_RETRY_MS = 10;
/** Backs the synchronous retry sleep: the ledger API is sync, so no timers. */
const LOCK_WAIT_CELL = new Int32Array(new SharedArrayBuffer(4));

/**
 * Run a read-modify-write of state.json under an exclusive lock file.
 *
 * The atomic rename in writeState only prevents torn reads. Without this lock, two
 * processes recording TTLs at the same moment (parallel `run --ttl` jobs, MCP and CLI
 * side by side) each rewrite the ledger from their own stale copy and drop the other's
 * entry, and a dropped entry is an instance the sweep will never power off.
 */
function withStateLock<T>(update: () => T): T {
  const lock = `${statePath()}.lock`;
  const token = `${process.pid}:${randomUUID()}`;
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeSync(fd, token);
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let age: number;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // Released between our open and stat: just retry.
      }
      if (age > LOCK_STALE_MS) rmSync(lock, { force: true });
      else Atomics.wait(LOCK_WAIT_CELL, 0, 0, LOCK_RETRY_MS);
    }
  }
  try {
    return update();
  } finally {
    // Only remove our own lock: if we were slow enough to be declared stale, the
    // file now belongs to whoever took over.
    try {
      if (readFileSync(lock, "utf8") === token) rmSync(lock, { force: true });
    } catch {
      // Already gone.
    }
  }
}

export function trackInstance(entry: TrackedInstance): void {
  withStateLock(() => {
    const state = readState();
    state.tracked[entry.uuid] = entry;
    writeState(state);
  });
}

export function untrackInstance(uuid: string): void {
  withStateLock(() => {
    const state = readState();
    if (state.tracked[uuid]) {
      delete state.tracked[uuid];
      writeState(state);
    }
  });
}

export function getTracked(uuid: string): TrackedInstance | undefined {
  return readState().tracked[uuid];
}

export function listTracked(): TrackedInstance[] {
  return Object.values(readState().tracked);
}

/** Entries whose TTL has elapsed as of `now`. */
export function listExpired(now = Date.now()): TrackedInstance[] {
  return listTracked().filter((entry) => entry.expiresAt <= now);
}
