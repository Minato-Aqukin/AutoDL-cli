import type { AutoDLClient } from "../core/client.js";
import { formatDuration } from "../core/duration.js";
import { powerOffInstance } from "../core/endpoints/instance.js";
import { debug, note, warn } from "../output/format.js";
import { execCommand } from "../ssh/exec.js";

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
  reason: "idle" | "aborted" | "dry-run";
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
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
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
      utilisation = parseUtilisation(result.stdout);
    } catch (err) {
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
