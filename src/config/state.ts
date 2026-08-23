import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function trackInstance(entry: TrackedInstance): void {
  const state = readState();
  state.tracked[entry.uuid] = entry;
  writeState(state);
}

export function untrackInstance(uuid: string): void {
  const state = readState();
  if (state.tracked[uuid]) {
    delete state.tracked[uuid];
    writeState(state);
  }
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
