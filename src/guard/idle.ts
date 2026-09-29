import type { AutoDLClient } from "../core/client.js";
import { formatDuration } from "../core/duration.js";
import { powerOffInstance } from "../core/endpoints/instance.js";
import { AutoDLError, NotFoundError, UsageError } from "../core/errors.js";
import { debug, note, warn } from "../output/format.js";
import { execCommand } from "../ssh/exec.js";

const NON_RUNNING_STATUSES: Record<string, true> = {
  shutdown: true,
  shutting_down: true,
  released: true,
  releasing: true,
};

function isInstanceGone(err: unknown): boolean {
  if (err instanceof NotFoundError) return true;
  if (err instanceof AutoDLError) {
    const status = err.details?.status;
    return typeof status === "string" && NON_RUNNING_STATUSES[status] === true;
  }
  return false;
}

/**
 * Idle detection.
 *
 * The TTL guard handles "this job should never run longer than N hours". This handles
 * the other half: a job that finished (or crashed) an hour ago while the meter kept
 * running. We sample GPU utilisation over SSH and power off after a sustained lull.
 */

export interface IdleOptions {
  /** Utilisation percentage at or below which a sample counts as idle. */
  thresholdPercent?: number;
  /** Consecutive idle samples required before shutting down. */
  samples?: number;
  /** Seconds between samples. */
  intervalSeconds?: number;
  /** Report but don't actually power off. */
  dryRun?: boolean;
  signal?: AbortSignal;
  onSample?: (utilisation: number, consecutiveIdle: number) => void;
}

export interface IdleResult {
  stopped: boolean;
  samplesTaken: number;
  lastUtilisation: number | null;
  reason: "idle" | "aborted" | "dry-run" | "not-running";
}

const QUERY = "nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits";

/** Average utilisation across all GPUs, or null when nvidia-smi gave us nothing usable. */
export function parseUtilisation(stdout: string): number | null {
  const values = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const onAbort = (): void => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    resolve();
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}

/**
 * Watch an instance and power it off once the GPU has been quiet long enough.
 * Blocks until it shuts the instance down or the signal aborts.
 */
export async function watchIdle(
  client: AutoDLClient,
  uuid: string,
  options: IdleOptions = {},
): Promise<IdleResult> {
  const threshold = options.thresholdPercent ?? 5;
  const required = options.samples ?? 6;
  const intervalSeconds = options.intervalSeconds ?? 60;
  if (!Number.isInteger(required) || required < 1) {
    throw new UsageError(`闲置采样次数必须是 ≥ 1 的整数，收到 ${options.samples}`, {
      hint: "例如 --samples 6 表示连续 6 次闲置后关机。",
    });
  }
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
    throw new UsageError(`闲置阈值必须是有限数字，收到 ${options.thresholdPercent}`, {
      hint: "例如 --threshold 5 表示利用率 ≤ 5% 视为闲置。",
    });
  }
  if (
    typeof intervalSeconds !== "number" ||
    !Number.isFinite(intervalSeconds) ||
    intervalSeconds <= 0
  ) {
    throw new UsageError(`采样间隔必须是大于 0 的时长，收到 ${options.intervalSeconds}`, {
      hint: "例如 --interval 1m 表示每分钟采样一次。",
    });
  }

  let consecutive = 0;
  let taken = 0;
  let last: number | null = null;

  note(
    `闲置检测已启动：GPU 利用率 ≤ ${threshold}% 连续 ${required} 次（每 ${formatDuration(intervalSeconds)} 一次）后自动关机`,
  );

  while (!options.signal?.aborted) {
    let utilisation: number | null = null;
    try {
      const result = await execCommand(client, uuid, QUERY, { capture: true, timeoutMs: 60_000 });
      // A Ctrl-C that lands mid-sample must stop the watcher before it counts or
      // powers anything off — never shut down a box the user asked us to leave.
      if (options.signal?.aborted) break;
      utilisation = parseUtilisation(result.stdout);
    } catch (err) {
      // A stopped/released instance is not a transient hiccup: its SSH gate throws
      // with the instance status attached (or NotFound once released). End the watch
      // instead of polling a dead box forever.
      if (isInstanceGone(err)) {
        debug(`实例 ${uuid} 已不在运行，结束闲置检测`);
        return {
          stopped: false,
          samplesTaken: taken,
          lastUtilisation: last,
          reason: "not-running",
        };
      }
      // A transient SSH hiccup must not be read as "idle" — that would shut down a
      // perfectly busy instance. Skip the sample instead.
      debug(`采样失败，跳过本次：${(err as Error).message}`);
      await sleep(intervalSeconds * 1000, options.signal);
      continue;
    }

    taken++;
    if (utilisation === null) {
      warn("nvidia-smi 未返回可用数据，跳过本次采样");
      await sleep(intervalSeconds * 1000, options.signal);
      continue;
    }

    last = utilisation;
    consecutive = utilisation <= threshold ? consecutive + 1 : 0;
    options.onSample?.(utilisation, consecutive);
    debug(`GPU 利用率 ${utilisation.toFixed(1)}%（连续闲置 ${consecutive}/${required}）`);

    if (consecutive >= required) {
      if (options.dryRun) {
        note("dry-run：本应在此关机");
        return { stopped: false, samplesTaken: taken, lastUtilisation: last, reason: "dry-run" };
      }
      await powerOffInstance(client, uuid);
      return { stopped: true, samplesTaken: taken, lastUtilisation: last, reason: "idle" };
    }

    await sleep(intervalSeconds * 1000, options.signal);
  }

  return { stopped: false, samplesTaken: taken, lastUtilisation: last, reason: "aborted" };
}
