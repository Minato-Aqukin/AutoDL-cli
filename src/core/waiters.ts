import type { AutoDLClient } from "./client.js";
import { getInstanceStatus } from "./endpoints/instance.js";
import { AutoDLError, TimeoutError } from "./errors.js";

export interface WaitOptions {
  /** Give up after this many ms. */
  timeoutMs?: number;
  /** Gap between status polls. */
  intervalMs?: number;
  /** Progress callback, e.g. to drive a spinner. */
  onPoll?: (status: string, elapsedMs: number) => void;
  signal?: AbortSignal;
}

/** States AutoDL will never leave on its own — waiting past them is pointless. */
const TERMINAL_FAILURES = new Set(["failed", "released", "releasing"]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new AutoDLError("操作已取消"));
      },
      { once: true },
    );
  });
}

/**
 * Poll `instance/pro/status` until it reaches one of `targets`.
 *
 * Used before every SSH attempt: AutoDL reassigns the SSH port and root password on
 * each power cycle, and the snapshot is only trustworthy once the instance is running.
 */
export async function waitForStatus(
  client: AutoDLClient,
  uuid: string,
  targets: string[],
  options: WaitOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const intervalMs = options.intervalMs ?? 5_000;
  const wanted = new Set(targets);
  const startedAt = Date.now();

  for (;;) {
    const status = await getInstanceStatus(client, uuid);
    const elapsed = Date.now() - startedAt;
    options.onPoll?.(status, elapsed);

    if (wanted.has(status)) return status;

    if (TERMINAL_FAILURES.has(status) && !wanted.has(status)) {
      throw new AutoDLError(
        `实例 ${uuid} 进入了 "${status}" 状态，无法继续等待 ${targets.join("/")}`,
        {
          details: { status },
        },
      );
    }

    if (elapsed >= timeoutMs) {
      throw new TimeoutError(
        `等待实例 ${uuid} 变为 ${targets.join("/")} 超时（当前状态 "${status}"）`,
        { hint: "可以稍后运行 `autodl info <id>` 查看实例是否已就绪。", details: { status } },
      );
    }

    await sleep(intervalMs, options.signal);
  }
}

export const waitForRunning = (client: AutoDLClient, uuid: string, options?: WaitOptions) =>
  waitForStatus(client, uuid, ["running"], options);

export const waitForShutdown = (client: AutoDLClient, uuid: string, options?: WaitOptions) =>
  waitForStatus(client, uuid, ["shutdown"], options);
