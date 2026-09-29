import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { configDir } from "../config/store.js";
import type { AutoDLClient } from "../core/client.js";
import { AutoDLError } from "../core/errors.js";
import type {
  FileConflict,
  FileConflictResolution,
  FileTransferProgress,
  FileTransferRequest,
} from "./file-types.js";
import { FileWorkspace } from "./files.js";
import type { TransferJob, TransferQueueView } from "./queue-types.js";

/**
 * Serial persistent transfer queue.
 *
 * Design notes for future readers:
 * - One job runs at a time, FIFO. Newly enqueued jobs start via `pump()`;
 *   restored jobs NEVER autostart (they load as `paused`).
 * - Persistence is one atomic JSON file per job under
 *   `<configDir>/transfers/<namespace>/`, plus fail-fast bakery ownership over
 *   per-process unique `.owner-<pid>-<nonce>.lock` claim files. Atomic rename
 *   alone can't stop two processes resuming the same persisted job and
 *   corrupting the SAME partial/destination — so the first mutation
 *   (enqueue/resume/cancel/resolve) publishes ticket 0, reaps ONLY dead-pid
 *   unique names, fails busy on any live/choosing/invalid claim, else takes
 *   max(ticket)+1 and wins only the earliest (ticket, nonce). A crashed owner
 *   leaves an abandoned unique file its pid no longer resolves for; the next
 *   writer deletes just that immutable name, never a live successor — so no
 *   central stale rm race exists. A merely viewing queue claims nothing and
 *   creates no files.
 * - Records are credential-free (paths/uuid/flags only). Secrets are also
 *   scrubbed out of error strings before they reach `job.error`.
 * - The queue NEVER powers an instance on. It constructs `FileWorkspace` per
 *   `request.uuid` and lets the engine re-read fresh status on retry; queue
 *   retries cover only recoverable transport failures and never pass any
 *   auto-start option.
 */

const RECORD_VERSION = 2;
const MAX_ATTEMPTS = 3;
/** Real, abortable delays between transport retries (indexed by failed attempt). */
const RETRY_DELAYS_MS = [2_000, 5_000];
const PROGRESS_EMIT_MS = 100;
const NAMESPACE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
/**
 * Per-process unique claim files: `.owner-<pid>-<nonce>.lock`. The pid in the
 * name allows dead-process cleanup that deletes ONLY immutable unique names,
 * never a live successor's file — so no central stale rm race exists.
 */
const OWNER_CLAIM_PREFIX = ".owner-";
const OWNER_CLAIM_SUFFIX = ".lock";
/** Same-process writers share a pid, so claims alone cannot tell them apart. */
const liveOwners = new Set<string>();
/** Durable ids are randomUUIDs so they double as safe record filenames. */
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOB_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;
const OWNER_CLAIM_PATTERN =
  /^\.owner-(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/i;
const jobIdSchema = z.string().regex(JOB_ID_PATTERN, "任务 id 须为 randomUUID");

const FileTransferRequestSchema = z.object({
  id: jobIdSchema,
  uuid: z.string().min(1),
  direction: z.union([z.literal("upload"), z.literal("download")]),
  sources: z.array(z.string().min(1)).min(1),
  destination: z.string().min(1),
  sync: z.boolean(),
  checksum: z.boolean(),
});

const EnqueueRequestSchema = FileTransferRequestSchema.omit({ id: true });

const PersistedJobSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  id: jobIdSchema,
  enqueuedAt: z.number(),
  updatedAt: z.number(),
  request: FileTransferRequestSchema,
  state: z.union([
    z.literal("queued"),
    z.literal("running"),
    z.literal("conflict"),
    z.literal("paused"),
    z.literal("completed"),
    z.literal("cancelled"),
  ]),
  error: z.string().optional(),
  result: z
    .object({ files: z.number(), bytes: z.number(), skipped: z.array(z.string()) })
    .optional(),
  conflict: z
    .object({
      source: z.string(),
      destination: z.string(),
      sourceSize: z.number(),
      destinationSize: z.number(),
    })
    .optional(),
  resolution: z
    .object({ choice: z.enum(["overwrite", "skip", "keep-both"]), applyToAll: z.boolean() })
    .optional(),
});

type PersistedJob = z.infer<typeof PersistedJobSchema>;

interface RuntimeJob {
  request: FileTransferRequest;
  state: TransferJob["state"];
  progress?: FileTransferProgress;
  conflict?: FileConflict;
  result?: TransferJob["result"];
  error?: string;
  resolution?: FileConflictResolution;
  enqueuedAt: number;
  abort?: AbortController;
  cancelRequested: boolean;
  lastEmitAt: number;
}

interface PendingConflict {
  resolve: (resolution: FileConflictResolution) => void;
  reject: (err: Error) => void;
  onAbort: () => void;
}

/** Internal abort signal, distinct from engine errors. */
class QueueAbortError extends Error {
  constructor() {
    super("操作已取消");
    this.name = "QueueAbortError";
  }
}

function validateStoredRecord(raw: unknown, filename: string): PersistedJob {
  // Records written before applyToAll was persisted store `resolution` as a
  // bare choice string; normalize to the object form before schema parsing.
  if (
    typeof raw === "object" &&
    raw !== null &&
    "resolution" in raw &&
    typeof raw.resolution === "string"
  ) {
    (raw as { resolution: unknown }).resolution = {
      choice: raw.resolution,
      applyToAll: false,
    };
  }
  const parsed = PersistedJobSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues[0]?.message ?? "格式非法";
    throw new Error(`传输记录损坏（${filename}）：${detail}`);
  }
  const rec = parsed.data;
  if (`${rec.id}.json` !== filename) {
    throw new Error(`传输记录损坏（${filename}）：文件名与记录 id 不一致`);
  }
  if (rec.request.id !== rec.id) {
    throw new Error(`传输记录损坏（${filename}）：请求 id 与记录 id 不一致`);
  }
  return rec;
}

/** Strip credential-shaped material so raw failures are safe for the UI. */
function toJobError(err: unknown): string {
  let message: string;
  let hint: string | undefined;
  if (err instanceof AutoDLError) {
    message = err.message;
    hint = err.hint;
  } else if (err instanceof Error) {
    message = err.message;
  } else {
    message = String(err);
  }
  const combined = hint ? `${message}（${hint}）` : message;
  const clean = combined
    .replace(/(password|passwd|pwd|token|secret)\s*[:=]\s*\S+/gi, "$1=****")
    .replace(/(-p|--password)\s+\S+/g, "$1 ****")
    .trim();
  return clean || "传输失败";
}

const RETRYABLE_ERRNO: Record<string, true> = {
  ECONNRESET: true,
  ETIMEDOUT: true,
  EPIPE: true,
  ECONNREFUSED: true,
  ENOTFOUND: true,
  EHOSTUNREACH: true,
  ENETUNREACH: true,
  EAI_AGAIN: true,
};

/**
 * Only known transport failures may be retried. Auth failures (either
 * language), API status failures and local errors pause immediately and never
 * power on. Cause/code chains are followed recursively so a wrapped auth or a
 * powered-off SSH_FAILED is never misread as a disconnect.
 */
function isRecoverable(err: unknown): boolean {
  if (err instanceof QueueAbortError) return false;
  if (err instanceof AutoDLError) {
    if (err.code === "NETWORK" || err.code === "TIMEOUT") return true;
    // SSH_FAILED carries both disconnects and credential/power rejections;
    // only the wrapped cause decides. Anything without a recoverable cause
    // chain pauses.
    if (err.code === "SSH_FAILED") return hasRecoverableCause(err.cause);
    return false;
  }
  return hasRecoverableCause(err);
}

function hasRecoverableCause(err: unknown, depth = 0): boolean {
  if (err === null || err === undefined) return false;
  if (depth > 5) return false;
  if (err instanceof AutoDLError) {
    if (err.code === "NETWORK" || err.code === "TIMEOUT") return true;
    if (err.code === "SSH_FAILED") return hasRecoverableCause(err.cause, depth + 1);
    return false;
  }
  if (typeof err === "object" && "code" in err && typeof err.code === "string") {
    if (RETRYABLE_ERRNO[err.code]) return true;
    // A coded non-transport failure (auth/status/local errno) is decisive:
    // only a recoverable wrapped cause below may still qualify.
    if (err instanceof Error && err.cause !== undefined) {
      return hasRecoverableCause(err.cause, depth + 1);
    }
    return false;
  }
  // ssh2 tags failures with a channel level; client-authentication (wrong
  // password / rejected key) must never retry, per the credentials contract.
  if (typeof err === "object" && "level" in err && typeof err.level === "string") {
    if (/auth/i.test(err.level)) return false;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (isAuthLike(msg) || isLocalLike(msg)) return false;
  if (isTransportLike(msg)) return true;
  if (err instanceof Error && err.cause !== undefined) {
    return hasRecoverableCause(err.cause, depth + 1);
  }
  return false;
}

function isAuthLike(msg: string): boolean {
  return /auth|password|passwd|credential|permission denied|unauthorized|forbidden|invalid token|expired|登录|密码|权限|认证|未授权|关机|已关机|开机|power|shutdown|offline|not running|无法建立|状态为/i.test(
    msg,
  );
}

function isLocalLike(msg: string): boolean {
  return /not found|ENOENT|EACCES|EPERM|EROFS|ENOSPC|EEXIST/i.test(msg);
}

function isTransportLike(msg: string): boolean {
  // Bare 通道/连接 alone never qualifies; the qualified alternatives below
  // require 中断/断开/重置/超时/关闭/丢失 so a powered-off "无法建立连接"
  // pauses instead of retrying.
  return /disconnect|ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|timed out|timeout|socket|closed|unreachable|temporar|connection lost|broken pipe|reset by peer|通道.{0,8}(中断|断开|重置|超时|关闭)|连接.{0,8}(中断|断开|重置|超时|关闭|丢失)/i.test(
    msg,
  );
}

/** A dead pid proves the owner crashed; kill(pid, 0) throws ESRCH then. */
function isLivePid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err) {
      // EPERM means the process exists but we may not signal it: still live.
      if (err.code === "EPERM") return true;
    }
    return false;
  }
}

interface OwnerClaim {
  file: string;
  pid: number;
  nonce: string;
  ticket: number | undefined;
}

/**
 * List this namespace's claim files without touching them. Parsing is
 * fail-closed: an empty/partial write or foreign file reads as an invalid
 * claim that blocks acquisition rather than being reaped.
 */
function listOwnerClaims(dir: string): OwnerClaim[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const claims: OwnerClaim[] = [];
  for (const file of files) {
    if (file.includes(".tmp.")) continue;
    if (!file.startsWith(OWNER_CLAIM_PREFIX) || !file.endsWith(OWNER_CLAIM_SUFFIX)) continue;
    const match = OWNER_CLAIM_PATTERN.exec(file);
    if (!match?.[1] || !match[2]) {
      claims.push({ file, pid: Number.NaN, nonce: "", ticket: undefined });
      continue;
    }
    let ticket: number | undefined;
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf8")) as unknown;
      if (
        typeof raw === "object" &&
        raw !== null &&
        "ticket" in raw &&
        typeof raw.ticket === "number" &&
        Number.isInteger(raw.ticket) &&
        raw.ticket >= 0
      ) {
        ticket = raw.ticket;
      }
    } catch {
      ticket = undefined;
    }
    claims.push({ file, pid: Number(match[1]), nonce: match[2].toLowerCase(), ticket });
  }
  return claims;
}

/** Delete ONLY this exact unique claim name; never touches a successor. */
function removeOwnClaim(dir: string, file: string): void {
  try {
    rmSync(join(dir, file), { force: true });
  } catch {
    // Best effort only.
  }
}

/** Delete ONLY dead-pid unique claims; live claims (any ticket state) stay. */
function reapDeadClaims(dir: string, claims: OwnerClaim[]): void {
  for (const claim of claims) {
    if (Number.isInteger(claim.pid) && !isLivePid(claim.pid)) {
      removeOwnClaim(dir, claim.file);
    }
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  // Promise executor form: the delay must race a timer against abort.
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new QueueAbortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new QueueAbortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function freezeJob(job: RuntimeJob): TransferJob {
  return Object.freeze({
    request: Object.freeze({ ...job.request }),
    state: job.state,
    ...(job.progress ? { progress: Object.freeze({ ...job.progress }) } : {}),
    ...(job.conflict ? { conflict: Object.freeze({ ...job.conflict }) } : {}),
    ...(job.result
      ? { result: Object.freeze({ ...job.result, skipped: [...job.result.skipped] }) }
      : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
  });
}

export class TransferQueue implements TransferQueueView {
  private readonly client: AutoDLClient;
  private readonly dir: string;
  private claimFile: string | undefined;
  private readonly jobs: RuntimeJob[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly conflicts = new Map<string, PendingConflict>();
  private active: { id: string; done: Promise<void> } | null = null;
  private cached: readonly TransferJob[] | null = null;
  private pausing = false;
  private disposed = false;

  constructor(client: AutoDLClient, namespace: string) {
    if (!NAMESPACE_PATTERN.test(namespace)) {
      throw new Error("传输队列命名空间非法：须为 8–128 位字母/数字/_/-");
    }
    this.client = client;
    this.dir = join(configDir(), "transfers", namespace);
    for (const job of this.load()) {
      this.jobs.push(job);
    }
    // Never autostart: restored jobs stay paused until explicitly resumed.
  }

  snapshot(): readonly TransferJob[] {
    if (!this.cached) {
      this.cached = Object.freeze(this.jobs.map(freezeJob));
    }
    return this.cached;
  }

  subscribe(listener: () => void): () => void {
    this.assertUsable();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  enqueue(request: Omit<FileTransferRequest, "id">): string {
    this.assertUsable();
    const parsed = EnqueueRequestSchema.safeParse(request);
    if (!parsed.success) {
      const detail = parsed.error.issues[0]?.message ?? "格式非法";
      throw new Error(`传输请求非法：${detail}`);
    }
    // Claim only for a valid mutation; invalid input creates no files.
    this.claimOwnership();
    const id = randomUUID();
    const job: RuntimeJob = {
      request: { ...parsed.data, id },
      state: "queued",
      enqueuedAt: Date.now(),
      cancelRequested: false,
      lastEmitAt: 0,
    };
    this.jobs.push(job);
    try {
      this.save(job);
    } catch (err) {
      // Don't leave a ghost job that recovery can never see.
      const index = this.jobs.indexOf(job);
      if (index >= 0) this.jobs.splice(index, 1);
      throw err;
    }
    this.emit();
    this.pump();
    return id;
  }

  resume(id: string): void {
    this.assertUsable();
    const job = this.jobOrThrow(id);
    if (job.state !== "paused" && job.state !== "cancelled") return;
    try {
      this.validateStored(job);
    } catch (err) {
      job.error = toJobError(err);
      this.emit();
      throw err;
    }
    // Claim only when we will actually run; validation failures stay lock-free.
    this.claimOwnership();
    const prev = { ...job };
    job.state = "queued";
    job.error = undefined;
    job.result = undefined;
    job.conflict = undefined;
    try {
      this.save(job);
    } catch (err) {
      Object.assign(job, prev);
      this.emit();
      throw err;
    }
    this.emit();
    this.pump();
  }

  cancel(id: string): void {
    this.assertUsable();
    const job = this.jobOrThrow(id);
    if (job.state === "completed" || job.state === "cancelled") return;
    this.claimOwnership();
    if (job.state === "running" || job.state === "conflict") {
      // The run loop settles the state; aborting also rejects the pending
      // conflict promise so close/cancel during conflict unblocks everything.
      job.cancelRequested = true;
      job.abort?.abort();
      this.emit();
      return;
    }
    const prevState = job.state;
    const prevConflict = job.conflict;
    job.state = "cancelled";
    job.conflict = undefined;
    try {
      this.save(job);
    } catch (err) {
      job.state = prevState;
      job.conflict = prevConflict;
      this.emit();
      throw err;
    }
    this.emit();
  }
  resolveConflict(id: string, resolution: FileConflictResolution): void {
    this.assertUsable();
    const job = this.jobOrThrow(id);
    if (
      !resolution ||
      (resolution.choice !== "overwrite" &&
        resolution.choice !== "skip" &&
        resolution.choice !== "keep-both")
    ) {
      throw new Error(`任务 ${id}：冲突处理选项非法`);
    }
    const pending = this.conflicts.get(id);
    if (pending && job.state === "conflict") {
      // Live conflict in this process: answer it directly.
      this.claimOwnership();
      pending.resolve({ choice: resolution.choice, applyToAll: resolution.applyToAll === true });
      return;
    }
    // Cross-process answer: the waiting run loop lives elsewhere (or the job
    // is parked paused by an earlier dispose). Persist the choice so the next
    // resume applies it via the checkpoint; then wake the job if it's ours.
    if (job.state !== "conflict" && job.state !== "paused") {
      throw new Error(`任务 ${id} 当前没有待处理的冲突`);
    }
    this.claimOwnership();
    const stored: FileConflictResolution = {
      choice: resolution.choice,
      applyToAll: resolution.applyToAll === true,
    };
    job.resolution = stored;
    job.conflict = undefined;
    if (job.state === "conflict") job.state = "paused";
    try {
      this.save(job);
    } catch (err) {
      job.resolution = undefined;
      this.emit();
      throw err;
    }
    if (job.state === "paused") this.resume(id);
  }

  hasPending(): boolean {
    return this.jobs.some(
      (job) => job.state === "queued" || job.state === "running" || job.state === "conflict",
    );
  }

  async pauseAll(): Promise<void> {
    if (this.disposed) return;
    this.pausing = true;
    let firstError: unknown;
    try {
      firstError = this.parkQueued() ?? firstError;
      for (const job of this.jobs) {
        job.abort?.abort();
      }
      const active = this.active;
      if (active) await active.done;
      // Jobs queued while the active run drained (e.g. a concurrent enqueue
      // during exit) must also park; never leave fresh queued work behind.
      firstError = this.parkQueued() ?? firstError;
      this.emit();
      if (firstError) throw firstError;
    } finally {
      this.pausing = false;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    try {
      await this.pauseAll();
    } finally {
      this.disposed = true;
      this.listeners.clear();
      this.conflicts.clear();
      this.releaseOwnership();
    }
  }

  /** Park every queued job as paused, persisting each record. */
  private parkQueued(): unknown {
    let firstError: unknown;
    for (const job of this.jobs) {
      if (job.state === "queued") {
        job.state = "paused";
        try {
          this.save(job);
        } catch (err) {
          // Keep pausing everything else; the caller surfaces the failure.
          firstError = firstError ?? err;
        }
      }
    }
    return firstError;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("传输队列已释放");
  }

  private jobOrThrow(id: string): RuntimeJob {
    // Ids are randomUUIDs by schema, so they can never escape the record dir
    // via save()/validateStored() path joins. Reject anything else up front.
    if (!JOB_ID_PATTERN.test(id)) throw new Error(`未知传输任务：${id}`);
    const job = this.jobs.find((j) => j.request.id === id);
    if (!job) throw new Error(`未知传输任务：${id}`);
    return job;
  }

  private emit(): void {
    this.cached = null;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A UI subscriber must never break queue accounting.
      }
    }
  }

  /** Invalidate the cached snapshot; notify subscribers at most ~10/s. */
  private noteProgress(): void {
    this.cached = null;
    const now = Date.now();
    const running = this.jobs.find((j) => j.state === "running");
    if (running && now - running.lastEmitAt < PROGRESS_EMIT_MS) return;
    if (running) running.lastEmitAt = now;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A UI subscriber must never break queue accounting.
      }
    }
  }

  private pump(): void {
    if (this.disposed || this.pausing || this.active) return;
    const next = this.jobs.find((job) => job.state === "queued");
    if (!next) return;
    const done = this.runJob(next).then(
      () => undefined,
      () => undefined,
    );
    this.active = { id: next.request.id, done };
    void done.then(() => {
      if (this.active?.done === done) this.active = null;
      if (!this.disposed && !this.pausing) this.pump();
    });
  }

  private async runJob(job: RuntimeJob): Promise<void> {
    job.state = "running";
    job.error = undefined;
    job.result = undefined;
    job.progress = undefined;
    job.conflict = undefined;
    job.cancelRequested = false;
    const aborter = new AbortController();
    job.abort = aborter;
    // Persist BEFORE any remote side effect so a crash can always recover.
    try {
      this.save(job);
    } catch (err) {
      job.state = "paused";
      job.error = toJobError(err);
      job.abort = undefined;
      this.emit();
      return;
    }
    this.emit();
    // Re-validate the disk record before touching the remote side.
    try {
      this.validateStored(job);
    } catch (err) {
      job.state = "paused";
      job.error = toJobError(err);
      job.abort = undefined;
      this.persistBestEffort(job);
      this.emit();
      return;
    }

    let workspace: FileWorkspace;
    try {
      // One workspace per request uuid; the engine never powers the instance on.
      workspace = new FileWorkspace(this.client, job.request.uuid);
    } catch (err) {
      job.state = "paused";
      job.error = toJobError(err);
      job.abort = undefined;
      this.persistBestEffort(job);
      this.emit();
      return;
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (aborter.signal.aborted) break;
      try {
        const result = await workspace.transfer(
          job.request,
          {
            onProgress: (progress: FileTransferProgress) => {
              job.progress = { ...progress };
              // Volatile byte counters stay in memory; records persist on
              // transitions (persisting every chunk would churn the disk).
              this.noteProgress();
            },
            onConflict: (conflict: FileConflict): Promise<FileConflictResolution> => {
              // A cross-process `resolve` stored the answer before this run
              // started (or while we were away): apply without prompting,
              // keeping the stored applyToAll so `--all` survives the trip.
              if (job.resolution) {
                const stored = job.resolution;
                job.resolution = undefined;
                return Promise.resolve({ ...stored });
              }
              job.state = "conflict";
              job.conflict = { ...conflict };
              try {
                this.save(job);
              } catch (err) {
                return Promise.reject(err);
              }
              this.emit();
              // Promise executor form: the UI resolver must settle from outside.
              const conflictPromise = new Promise<FileConflictResolution>((resolve, reject) => {
                const onAbort = (): void => {
                  reject(new QueueAbortError());
                };
                if (aborter.signal.aborted) {
                  onAbort();
                } else {
                  this.conflicts.set(job.request.id, { resolve, reject, onAbort });
                  aborter.signal.addEventListener("abort", onAbort, { once: true });
                }
              });
              return conflictPromise
                .then((resolution) => {
                  // Back to active duty so the snapshot stops showing a prompt
                  // the UI already answered; the engine keeps transferring.
                  if (!aborter.signal.aborted && job.state === "conflict") {
                    job.state = "running";
                    job.conflict = undefined;
                    this.emit();
                  }
                  return resolution;
                })
                .finally(() => {
                  const pending = this.conflicts.get(job.request.id);
                  if (pending) {
                    aborter.signal.removeEventListener("abort", pending.onAbort);
                    this.conflicts.delete(job.request.id);
                  }
                });
            },
          },
          aborter.signal,
        );
        job.state = "completed";
        job.result = result;
        job.conflict = undefined;
        job.abort = undefined;
        if (!this.persistBestEffort(job)) {
          job.error = job.error ?? "传输完成，但队列持久化失败，重启后可能重复传输";
        }
        this.emit();
        return;
      } catch (err) {
        if (aborter.signal.aborted || err instanceof QueueAbortError) {
          job.state = job.cancelRequested ? "cancelled" : "paused";
          job.conflict = undefined;
          job.abort = undefined;
          this.persistBestEffort(job);
          this.emit();
          return;
        }
        if (!isRecoverable(err) || attempt >= MAX_ATTEMPTS) {
          job.state = "paused";
          job.error = toJobError(err);
          job.conflict = undefined;
          job.abort = undefined;
          this.persistBestEffort(job);
          this.emit();
          return;
        }
        try {
          await abortableDelay(RETRY_DELAYS_MS[attempt - 1] ?? 5_000, aborter.signal);
        } catch {
          job.state = job.cancelRequested ? "cancelled" : "paused";
          job.conflict = undefined;
          job.abort = undefined;
          this.persistBestEffort(job);
          this.emit();
          return;
        }
      }
    }
    job.state = job.cancelRequested ? "cancelled" : "paused";
    job.conflict = undefined;
    job.abort = undefined;
    this.persistBestEffort(job);
    this.emit();
  }

  private load(): RuntimeJob[] {
    let files: string[];
    try {
      files = readdirSync(this.dir);
    } catch (err) {
      // No directory yet: viewing an untouched queue creates no files.
      if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
        return [];
      }
      throw new Error(`读取传输队列失败：${toJobError(err)}`);
    }
    const loaded: RuntimeJob[] = [];
    for (const file of files) {
      // Only UUID records participate; owner claim files and strays are
      // never parsed as jobs. Non-UUID filenames can't escape metadata
      // because ids are schema-bound to randomUUID at the boundary.
      if (!JOB_FILE_PATTERN.test(file)) continue;
      const full = join(this.dir, file);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(full, "utf8"));
      } catch (err) {
        throw new Error(`传输记录损坏（${file}）：${toJobError(err)}`);
      }
      const rec = validateStoredRecord(raw, file);
      loaded.push({
        request: rec.request,
        // Unfinished work always resumes paused; nothing autostarts. A
        // persisted conflict detail and resolution survive the trip so a
        // fresh process can show and answer them.
        state:
          rec.state === "completed" || rec.state === "cancelled" || rec.state === "paused"
            ? rec.state
            : "paused",
        result: rec.result,
        error: rec.error,
        ...(rec.conflict ? { conflict: { ...rec.conflict } } : {}),
        ...(rec.resolution ? { resolution: { ...rec.resolution } } : {}),
        enqueuedAt: rec.enqueuedAt,
        cancelRequested: false,
        lastEmitAt: 0,
      });
    }
    loaded.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    return loaded;
  }

  private recordFor(job: RuntimeJob): PersistedJob {
    return {
      version: RECORD_VERSION,
      id: job.request.id,
      enqueuedAt: job.enqueuedAt,
      updatedAt: Date.now(),
      request: { ...job.request },
      state: job.state,
      ...(job.error !== undefined ? { error: job.error } : {}),
      ...(job.result ? { result: job.result } : {}),
      ...(job.conflict ? { conflict: { ...job.conflict } } : {}),
      ...(job.resolution ? { resolution: { ...job.resolution } } : {}),
    };
  }

  private save(job: RuntimeJob): void {
    let payload: string;
    try {
      payload = JSON.stringify(this.recordFor(job));
    } catch (err) {
      throw new Error(`传输队列持久化失败：${toJobError(err)}`);
    }
    const tmp = join(this.dir, `${job.request.id}.json.tmp.${process.pid}`);
    const final = join(this.dir, `${job.request.id}.json`);
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(tmp, payload, { mode: 0o600 });
      renameSync(tmp, final);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Best effort cleanup only.
      }
      throw new Error(`传输队列持久化失败：${toJobError(err)}`);
    }
  }

  /** Background-transition persist: surface failures on the job, never throw. */
  private persistBestEffort(job: RuntimeJob): boolean {
    try {
      this.save(job);
      return true;
    } catch (err) {
      job.error = toJobError(err);
      return false;
    }
  }

  /**
   * Claim exclusive mutation/run ownership for this namespace via fail-fast
   * bakery tickets over per-process unique claim files. Viewing, snapshotting
   * and subscribing never call this, so an empty view creates no files.
   *
   * Protocol: create `.owner-<pid>-<nonce>.lock` exclusively with ticket 0
   * (choosing), reap ONLY dead-pid unique names, fail busy if any live or
   * invalid claim exists, else publish max(ticket)+1 atomically and rescan:
   * win only when no live choosing claim remains and our (ticket, nonce) is
   * earliest; otherwise remove ONLY our own unique file and fail busy. A
   * crashed owner leaves an abandoned unique file its pid no longer resolves
   * for, so the next writer reaps just that immutable name without ever
   * deleting a live successor — no central stale rm race, no second reaper,
   * no external deps. Empty/partial writes parse fail-closed (invalid claim
   * blocks rather than being reaped). Same-process re-entry by one instance is
   * a no-op via `claimFile`; a second instance fails fast via liveOwners.
   */
  private claimOwnership(): void {
    if (this.claimFile || this.disposed) return;
    if (liveOwners.has(this.dir)) {
      throw new Error(
        "同一进程中该账号传输队列已有写入者：同一时间只允许一个队列实例写入，避免并发恢复同一任务损坏传输目标",
      );
    }
    const nonce = randomUUID();
    const file = `${OWNER_CLAIM_PREFIX}${process.pid}-${nonce}${OWNER_CLAIM_SUFFIX}`;
    const path = join(this.dir, file);
    let fd: number | undefined;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fd = openSync(path, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, nonce, ticket: 0, createdAt: Date.now() }));
      closeSync(fd);
      fd = undefined;
    } catch (err) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Best effort only; the claim already failed.
        }
      }
      throw new Error(`传输队列加锁失败：${toJobError(err)}`);
    }
    // Reap ONLY dead-pid unique claims; live or invalid claims stay and block.
    reapDeadClaims(this.dir, listOwnerClaims(this.dir));
    const rivals = listOwnerClaims(this.dir).filter((claim) => claim.file !== file);
    const liveRival = rivals.find(
      (claim) => claim.ticket === undefined || !Number.isInteger(claim.pid) || isLivePid(claim.pid),
    );
    if (liveRival) {
      removeOwnClaim(this.dir, file);
      throw new Error(
        Number.isInteger(liveRival.pid)
          ? `传输队列正由进程 ${liveRival.pid} 独占使用：同一账号队列同一时间只允许一个写入者，避免并发恢复同一任务损坏传输目标`
          : "传输队列正由另一写入者独占使用：同一账号队列同一时间只允许一个写入者，避免并发恢复同一任务损坏传输目标",
      );
    }
    // No live contender: take max(ticket)+1 over survivors (dead claims already
    // reaped, so the max reflects only live holders — normally none). The new
    // ticket is written to a unique temp file then atomically renamed, so a
    // concurrent lister never observes an empty/partial claim body: parsing is
    // only fail-closed for genuinely crashed writers, not for our own publish.
    let ticket = 1;
    for (const claim of rivals) {
      if (claim.ticket !== undefined && claim.ticket >= ticket) ticket = claim.ticket + 1;
    }
    const ticketPayload = JSON.stringify({
      pid: process.pid,
      nonce,
      ticket,
      createdAt: Date.now(),
    });
    const ticketTmp = `${path}.tmp.${process.pid}`;
    try {
      writeFileSync(ticketTmp, ticketPayload, { mode: 0o600 });
      renameSync(ticketTmp, path);
    } catch (err) {
      try {
        rmSync(ticketTmp, { force: true });
      } catch {
        // Best effort cleanup only.
      }
      removeOwnClaim(this.dir, file);
      throw new Error(`传输队列加锁失败：${toJobError(err)}`);
    }
    // Rescan: a newcomer that published while we chose shows as a live
    // choosing (ticket 0) claim and makes us lose; ties break on nonce order
    // so exactly one contender holds the earliest (ticket, nonce).
    const after = listOwnerClaims(this.dir).filter(
      (claim) => Number.isInteger(claim.pid) && isLivePid(claim.pid),
    );
    if (after.some((claim) => claim.file !== file && claim.ticket === undefined)) {
      removeOwnClaim(this.dir, file);
      throw new Error(
        "传输队列正由另一写入者独占使用：同一账号队列同一时间只允许一个写入者，避免并发恢复同一任务损坏传输目标",
      );
    }
    const ranked = after
      .filter((claim) => claim.ticket !== undefined)
      .sort(
        (a, b) =>
          (a.ticket as number) - (b.ticket as number) ||
          (a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0),
      );
    const earliest = ranked[0];
    if (!earliest || earliest.file !== file) {
      removeOwnClaim(this.dir, file);
      const holder =
        earliest && Number.isInteger(earliest.pid) ? `进程 ${earliest.pid}` : "另一写入者";
      throw new Error(
        `传输队列正由${holder}独占使用：同一账号队列同一时间只允许一个写入者，避免并发恢复同一任务损坏传输目标`,
      );
    }
    this.claimFile = file;
    liveOwners.add(this.dir);
  }

  /** Release our unique claim; deletes ONLY our own immutable filename. */
  private releaseOwnership(): void {
    if (!this.claimFile) return;
    const file = this.claimFile;
    this.claimFile = undefined;
    liveOwners.delete(this.dir);
    removeOwnClaim(this.dir, file);
  }

  /** Re-read and validate the disk record before any remote side effect. */
  private validateStored(job: RuntimeJob): void {
    const full = join(this.dir, `${job.request.id}.json`);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(full, "utf8"));
    } catch (err) {
      throw new Error(`传输记录不可用（${job.request.id}）：${toJobError(err)}`);
    }
    const rec = validateStoredRecord(raw, `${job.request.id}.json`);
    const want = job.request;
    const got = rec.request;
    if (
      got.uuid !== want.uuid ||
      got.direction !== want.direction ||
      got.destination !== want.destination ||
      got.sync !== want.sync ||
      got.checksum !== want.checksum ||
      got.sources.length !== want.sources.length ||
      !got.sources.every((s, i) => s === want.sources[i])
    ) {
      throw new Error(`传输记录与队列不一致（${job.request.id}），已停止执行`);
    }
  }
}
