import { mkdir } from "node:fs/promises";
import { untrackInstance } from "../config/state.js";
import {
  assertProCreateRegion,
  DEFAULT_BASE_IMAGE,
  findBaseImage,
  parseCudaVersion,
  resolveGpuSpec,
} from "../core/catalog.js";
import type { AutoDLClient } from "../core/client.js";
import { formatDuration } from "../core/duration.js";
import {
  createInstance,
  getInstanceStatus,
  powerOffInstance,
  releaseInstance,
} from "../core/endpoints/instance.js";
import { UsageError } from "../core/errors.js";
import { chooseRegions } from "../core/stock.js";
import { waitForRunning, waitForShutdown } from "../core/waiters.js";
import { assertBudget } from "../guard/budget.js";
import { composeStartCommand, recordTTL } from "../guard/ttl.js";
import { debug, isJson, note, success, warn } from "../output/format.js";
import { t } from "../output/i18n.js";
import { assertNotAborted } from "../ssh/credentials.js";
import { execCommand } from "../ssh/exec.js";
import { pull, push } from "../ssh/transfer.js";

export interface RunOptions {
  command: string;
  gpu: string;
  gpuNum?: number;
  image?: string;
  cudaFrom?: string | number;
  regions?: string[];
  diskGb?: number;
  name?: string;
  ttlSeconds: number;
  /** Local directory uploaded before the command runs. */
  sync?: string;
  /** Remote working directory; also the sync destination. */
  workdir?: string;
  /** Remote path copied back after the command finishes. */
  pullFrom?: string;
  /** Local destination for `pullFrom`. */
  pullTo?: string;
  /** What to do with the instance afterwards. */
  onFinish?: "poweroff" | "release" | "keep";
  /** Kill the remote command after this many ms. */
  commandTimeoutMs?: number;
  minBalanceYuan?: number;
  env?: Record<string, string>;
  /** Set false to skip the pre-create stock lookup. */
  stockCheck?: boolean;
  signal?: AbortSignal;
}

export interface RunResult {
  instanceUuid: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  uploaded: { files: number; bytes: number } | null;
  downloaded: { files: number; bytes: number } | null;
  finalAction: "poweroff" | "release" | "keep";
  durationMs: number;
  /**
   * What the post-run cleanup actually achieved. `finalAction` is the request;
   * this is the outcome — a failed power_off must not report `poweroff` as fact,
   * because in `--json`/MCP mode nobody sees the `warn()` it used to hide behind.
   */
  cleanup: { stopped: boolean; released: boolean; error: string | null };
}

/**
 * The data disk, not the system disk.
 *
 * `/root` is a fixed ~30GB system volume that also gets packed into any saved image;
 * `/root/autodl-tmp` is a separate, faster, expandable disk. AutoDL's own docs point
 * code and data here. Trade-off worth knowing: data-disk contents are NOT included
 * when you save an image.
 */
const DEFAULT_WORKDIR = "/root/autodl-tmp/autodl-cli";

/**
 * The single verb an agent reaches for: rent a box, put code on it, run something,
 * bring the results back, and give the box back.
 *
 * Every exit path — success, remote failure, Ctrl-C, a thrown error — routes through
 * the same cleanup, because the one unacceptable outcome is leaving a GPU powered on.
 */
export async function runWorkflow(client: AutoDLClient, options: RunOptions): Promise<RunResult> {
  const startedAt = Date.now();
  const spec = resolveGpuSpec(options.gpu);
  if (!spec) {
    throw new UsageError(`未知的 GPU 规格 "${options.gpu}"`, {
      hint: "运行 `autodl gpus` 查看官方 API 支持的全部规格。",
    });
  }

  const imageInput = options.image ?? DEFAULT_BASE_IMAGE;
  const image = findBaseImage(imageInput);
  const imageUuid = image?.uuid ?? imageInput;
  const cudaFrom = options.cudaFrom
    ? parseCudaVersion(options.cudaFrom)
    : parseCudaVersion(image?.cuda ?? "11.8");

  const requestedRegions = (options.regions ?? []).map((input) => assertProCreateRegion(input).id);

  const workdir = options.workdir ?? DEFAULT_WORKDIR;
  const onFinish = options.onFinish ?? "poweroff";

  await assertBudget(client, options.minBalanceYuan);

  const regions =
    options.stockCheck === false
      ? requestedRegions
      : (await chooseRegions(client, spec, requestedRegions)).regions;

  // Arm the shutdown timer at boot so the instance protects itself even if this
  // process dies before it can do anything else.
  const startCommand = composeStartCommand(options.ttlSeconds, undefined);

  // Ctrl-C during the budget/stock checks must not rent a GPU nobody will use.
  assertNotAborted(options.signal);
  note(t("instance.creating"));
  const uuid = await createInstance(client, {
    gpuSpec: spec.id,
    gpuNum: options.gpuNum ?? 1,
    imageUuid,
    cudaFrom,
    ...(options.diskGb !== undefined ? { expandSystemDiskGb: options.diskGb } : {}),
    ...(regions.length ? { regions } : {}),
    ...(options.name ? { name: options.name } : {}),
    ...(startCommand ? { startCommand } : {}),
  });
  recordTTL({
    uuid,
    ...(options.name ? { name: options.name } : {}),
    ttlSeconds: options.ttlSeconds,
    inInstanceTimer: true,
  });
  success(`${t("instance.created")}：${uuid}（TTL ${formatDuration(options.ttlSeconds)}）`);

  let uploaded: RunResult["uploaded"] = null;
  let downloaded: RunResult["downloaded"] = null;
  let exitCode: number | null = null;
  let stdout = "";
  let stderr = "";
  /** Set when the work threw; cleanup still runs before it is rethrown. */
  let failure: { error: unknown } | undefined;

  try {
    note(t("instance.waiting"));
    await waitForRunning(client, uuid, {
      ...(options.signal ? { signal: options.signal } : {}),
      onPoll: (status) => debug(`状态：${status}`),
    });
    success(t("instance.ready"));

    if (options.sync) {
      note(t("run.syncing"));
      uploaded = await push(client, uuid, options.sync, workdir, {
        ...(options.signal ? { signal: options.signal } : {}),
        onProgress: ({ file, index, total }) => debug(`↑ [${index}/${total}] ${file}`),
      });
      success(`已上传 ${uploaded.files} 个文件到 ${workdir}`);
    }

    note(t("run.executing"));
    const result = await execCommand(client, uuid, options.command, {
      capture: true,
      // Same rule as `autodl exec`: stdout only when it isn't carrying the payload.
      stdout: isJson() ? process.stderr : process.stdout,
      stderr: process.stderr,
      cwd: options.sync ? workdir : undefined,
      ...(options.env ? { env: options.env } : {}),
      ...(options.commandTimeoutMs !== undefined ? { timeoutMs: options.commandTimeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    exitCode = result.exitCode;
    stdout = result.stdout;
    stderr = result.stderr;

    if (options.pullFrom) {
      const target = options.pullTo ?? "./autodl-output";
      note(t("run.pulling"));
      await mkdir(target, { recursive: true });
      downloaded = await pull(client, uuid, options.pullFrom, target, {
        ...(options.signal ? { signal: options.signal } : {}),
        onProgress: ({ file, index, total }) => debug(`↓ [${index}/${total}] ${file}`),
      });
      success(`已回传 ${downloaded.files} 个文件到 ${target}`);
    }
  } catch (err) {
    failure = { error: err };
  }
  const cleanup = await finish(client, uuid, onFinish);
  if (failure) throw withCleanupFailure(failure.error, uuid, cleanup);

  return {
    instanceUuid: uuid,
    exitCode,
    stdout,
    stderr,
    uploaded,
    downloaded,
    finalAction: onFinish,
    durationMs: Date.now() - startedAt,
    cleanup,
  };
}

/**
 * A run that throws must not hide a failed cleanup either: the thrown error is all an
 * agent sees, so fold the cleanup failure into its message (type and exit code kept).
 */
export function withCleanupFailure(
  error: unknown,
  uuid: string,
  cleanup: RunResult["cleanup"],
): unknown {
  if (!cleanup.error || !(error instanceof Error)) return error;
  const state = cleanup.stopped ? `实例 ${uuid} 已关机但未释放` : `实例 ${uuid} 可能仍在计费`;
  error.message = `${error.message}（收尾也失败：${state}：${cleanup.error}）`;
  return error;
}

/**
 * Cleanup runs on every exit path, so it must never throw — an exception here would
 * mask the real error and, worse, hide the fact that the instance is still running.
 *
 * Returns what was actually achieved so the caller can report it (and exit
 * non-zero) instead of hiding a failed power_off behind a `warn()` that `--json`
 * and MCP mode never display.
 */
async function finish(
  client: AutoDLClient,
  uuid: string,
  action: "poweroff" | "release" | "keep",
): Promise<RunResult["cleanup"]> {
  if (action === "keep") {
    warn(`实例 ${uuid} 仍在运行（--on-finish keep），记得手动关机：autodl stop ${uuid}`);
    return { stopped: false, released: false, error: null };
  }

  note(t("run.cleanup"));
  try {
    // Skip the call if AutoDL is already stopping it; a duplicate is rejected.
    const status = await getInstanceStatus(client, uuid).catch(() => "unknown");
    if (status !== "shutdown" && status !== "shutting_down") {
      await powerOffInstance(client, uuid);
    }
    success(`实例 ${uuid} 已关机，计费已停止`);
  } catch (err) {
    const message = (err as Error).message;
    warn(`自动关机失败：${message}`);
    warn(`请立即手动处理：autodl stop ${uuid}`);
    return { stopped: false, released: false, error: message };
  }

  if (action === "release") {
    try {
      // AutoDL rejects a release until the instance has finished shutting down.
      await waitForShutdown(client, uuid, { timeoutMs: 10 * 60_000 });
      await releaseInstance(client, uuid);
      untrackInstance(uuid);
      success(`实例 ${uuid} 已释放`);
      return { stopped: true, released: true, error: null };
    } catch (err) {
      const message = (err as Error).message;
      warn(`释放失败（实例已关机，不再计费）：${message}`);
      warn(`稍后可重试：autodl rm ${uuid} --yes`);
      return { stopped: true, released: false, error: message };
    }
  }
  untrackInstance(uuid);
  return { stopped: true, released: false, error: null };
}
