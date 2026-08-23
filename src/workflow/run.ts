import { mkdir } from "node:fs/promises";
import { untrackInstance } from "../config/state.js";
import {
  DEFAULT_BASE_IMAGE,
  findBaseImage,
  parseCudaVersion,
  resolveGpuSpec,
  resolveRegion,
} from "../core/catalog.js";
import type { AutoDLClient } from "../core/client.js";
import { formatDuration } from "../core/duration.js";
import { createInstance, powerOffInstance, releaseInstance } from "../core/endpoints/instance.js";
import { UsageError } from "../core/errors.js";
import { waitForRunning } from "../core/waiters.js";
import { assertBudget } from "../guard/budget.js";
import { composeStartCommand, recordTTL } from "../guard/ttl.js";
import { debug, isJson, note, success, warn } from "../output/format.js";
import { t } from "../output/i18n.js";
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
}

const DEFAULT_WORKDIR = "/root/autodl-cli";

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

  const regions = (options.regions ?? []).map((input) => {
    const region = resolveRegion(input);
    if (!region) {
      throw new UsageError(`未知的地区 "${input}"`, {
        hint: "运行 `autodl regions` 查看地区列表。",
      });
    }
    return region.id;
  });

  const workdir = options.workdir ?? DEFAULT_WORKDIR;
  const onFinish = options.onFinish ?? "poweroff";

  await assertBudget(client, options.minBalanceYuan);

  // Arm the shutdown timer at boot so the instance protects itself even if this
  // process dies before it can do anything else.
  const startCommand = composeStartCommand(options.ttlSeconds, undefined);

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
  } finally {
    await finish(client, uuid, onFinish);
  }

  return {
    instanceUuid: uuid,
    exitCode,
    stdout,
    stderr,
    uploaded,
    downloaded,
    finalAction: onFinish,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Cleanup runs in a `finally`, so it must never throw — an exception here would mask
 * the real error and, worse, hide the fact that the instance is still running.
 */
async function finish(
  client: AutoDLClient,
  uuid: string,
  action: "poweroff" | "release" | "keep",
): Promise<void> {
  if (action === "keep") {
    warn(`实例 ${uuid} 仍在运行（--on-finish keep），记得手动关机：autodl stop ${uuid}`);
    return;
  }

  note(t("run.cleanup"));
  try {
    await powerOffInstance(client, uuid);
    success(`实例 ${uuid} 已关机，计费已停止`);
  } catch (err) {
    warn(`自动关机失败：${(err as Error).message}`);
    warn(`请立即手动处理：autodl stop ${uuid}`);
    return;
  }

  if (action === "release") {
    try {
      await releaseInstance(client, uuid);
      untrackInstance(uuid);
      success(`实例 ${uuid} 已释放`);
    } catch (err) {
      // Release right after power-off often races AutoDL's own state machine.
      warn(`释放失败（实例已关机，不再计费）：${(err as Error).message}`);
      warn(`稍后可重试：autodl rm ${uuid} --yes`);
    }
  } else {
    untrackInstance(uuid);
  }
}
