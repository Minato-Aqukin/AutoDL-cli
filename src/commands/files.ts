import { createHash } from "node:crypto";
import { resolve as resolveLocal } from "node:path";
import type { Command } from "commander";
import { resolveBaseUrl, resolveToken } from "../config/store.js";
import type { Context } from "../context.js";
import { DEFAULT_BASE_URL } from "../core/client.js";
import { AutoDLError, UsageError } from "../core/errors.js";
import { emit, note, printKeyValues, success } from "../output/format.js";
import { getCredentials } from "../ssh/credentials.js";
import { FileWorkspace } from "../ssh/files.js";
import { TransferQueue } from "../ssh/transfer-queue.js";
import { identityFromToken } from "../tui/account.js";
import { action, confirmDestructive, globalsOf } from "./helpers.js";
/** Same account/baseURL scoping as the dashboard, so CLI and TUI share one queue. */
export function queueNamespace(token: string, baseUrl: string | undefined): string {
  const identity = identityFromToken(token);
  const account = [identity.tenant, identity.uid ?? identity.uuid ?? token];
  return createHash("sha256")
    .update(JSON.stringify([(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""), account]))
    .digest("hex");
}

function queueFor(
  context: Context,
  command: Command,
): { queue: TransferQueue; release: () => Promise<void> } {
  const globals = globalsOf(command);
  const resolved = resolveToken(globals.token);
  const baseUrl = resolveBaseUrl(globals.baseUrl);
  const queue = new TransferQueue(context.client, queueNamespace(resolved.token, baseUrl));
  let released = false;
  return {
    queue,
    release: async () => {
      if (!released) {
        released = true;
        await queue.dispose();
      }
    },
  };
}

async function withWorkspace<T>(
  context: Context,
  id: string,
  fn: (workspace: FileWorkspace) => Promise<T>,
): Promise<T> {
  const workspace = new FileWorkspace(context.client, id);
  try {
    return await fn(workspace);
  } finally {
    workspace.dispose();
  }
}

async function ensureStarted(context: Context, id: string, start: boolean): Promise<void> {
  if (start) await getCredentials(context.client, id, { autoStart: true });
}

const STATE_LABEL: Record<string, string> = {
  queued: "排队",
  running: "传输中",
  conflict: "待确认",
  paused: "已暂停",
  completed: "完成",
  cancelled: "已取消",
};

export function registerFileCommands(program: Command): void {
  const files = program.command("files").description("浏览与管理实例文件（SFTP，连接复用）");

  files
    .command("ls <id> [remote]")
    .description("列出远程目录（当前层，无递归）")
    .option("--start", "实例未运行时自动开机", false)
    .action(
      action(
        async (context, id: string, remote: string | undefined, options: { start: boolean }) => {
          const dir = remote ?? "/root/autodl-tmp";
          const entries = await withWorkspace(context, id, async (workspace) => {
            await ensureStarted(context, id, options.start);
            return workspace.list("remote", dir);
          });
          emit({ uuid: id, path: dir, entries }, () => {
            for (const entry of entries) {
              printKeyValues([[entry.name, `${entry.kind} ${entry.size} ${entry.path}`]]);
            }
            if (entries.length === 0) note("空目录");
          });
          return 0;
        },
      ),
    );

  files
    .command("mkdir <id> <remote>")
    .description("在实例上创建目录")
    .option("--start", "实例未运行时自动开机", false)
    .action(
      action(async (context, id: string, remote: string, options: { start: boolean }) => {
        await withWorkspace(context, id, async (workspace) => {
          await ensureStarted(context, id, options.start);
          return workspace.mkdir("remote", remote);
        });
        emit({ uuid: id, path: remote, created: true }, () => success(`已创建 ${remote}`));
        return 0;
      }),
    );

  files
    .command("mv <id> <from> <to>")
    .description("在实例上改名或移动（不覆盖已存在目标）")
    .option("--start", "实例未运行时自动开机", false)
    .action(
      action(async (context, id: string, from: string, to: string, options: { start: boolean }) => {
        await withWorkspace(context, id, async (workspace) => {
          await ensureStarted(context, id, options.start);
          return workspace.rename("remote", from, to);
        });
        emit({ uuid: id, from, to, moved: true }, () => success(`已移动 ${from} → ${to}`));
        return 0;
      }),
    );

  files
    .command("rm <id> <remote>")
    .description("删除实例文件或目录（递归，不可恢复）")
    .option("--yes", "确认删除", false)
    .option("--start", "实例未运行时自动开机", false)
    .action(
      action(
        async (context, id: string, remote: string, options: { yes: boolean; start: boolean }) => {
          const confirmed = await confirmDestructive(
            `永久删除实例文件 ${id}:${remote}`,
            options.yes,
          );
          if (!confirmed) {
            emit({ uuid: id, path: remote, removed: false, cancelled: true }, () => note("已取消"));
            return 0;
          }
          await withWorkspace(context, id, async (workspace) => {
            await ensureStarted(context, id, options.start);
            return workspace.remove("remote", remote);
          });
          emit({ uuid: id, path: remote, removed: true }, () => success(`已删除 ${remote}`));
          return 0;
        },
      ),
    );

  const queue = program.command("queue").description("串行传输队列（与看板共用同一队列）");

  queue
    .command("add <id> <source> <destination>")
    .description("加入上传/下载任务（来源在本地则上传，在远端需 --download）")
    .option("--download", "从实例下载到本地", false)
    .option("--sync", "单向增量同步，不删除目标独有文件", false)
    .option("--checksum", "SHA-256 内容校验", false)
    .option("--wait", "等待任务完成", false)
    .action(
      action(
        async (
          context,
          id: string,
          source: string,
          destination: string,
          options: { download: boolean; sync: boolean; checksum: boolean; wait: boolean },
          command: Command,
        ) => {
          const { queue: transferQueue, release } = queueFor(context, command);
          try {
            // Persist absolute local paths: FileWorkspace.transfer resolves
            // against the resuming process's cwd, so a relative path stored
            // by one cwd breaks resume from anywhere else (dashboard included).
            const jobId = transferQueue.enqueue({
              uuid: id,
              direction: options.download ? "download" : "upload",
              sources: options.download ? [source] : [resolveLocal(source)],
              destination: options.download ? resolveLocal(destination) : destination,
              sync: options.sync,
              checksum: options.checksum,
            });
            if (options.wait) {
              const done = await waitForJob(transferQueue, jobId);
              if (done.state !== "completed") {
                throw new AutoDLError(
                  `任务 ${jobId} 未完成（${STATE_LABEL[done.state] ?? done.state}${done.error ? `：${done.error}` : ""}）`,
                );
              }
              emit({ jobId, ...done }, () =>
                success(`任务 ${jobId}：${STATE_LABEL[done.state] ?? done.state}`),
              );
              return 0;
            }
            emit({ jobId, uuid: id }, () => success(`已加入队列：${jobId}`));
            return 0;
          } finally {
            await release();
          }
        },
      ),
    );

  queue
    .command("ls")
    .description("列出当前账号的传输任务")
    .action(
      action(async (context, _options: Record<string, never>, command: Command) => {
        const { queue: transferQueue, release } = queueFor(context, command);
        try {
          const jobs = transferQueue.snapshot().map((job) => ({
            id: job.request.id,
            uuid: job.request.uuid,
            direction: job.request.direction,
            sources: job.request.sources,
            destination: job.request.destination,
            sync: job.request.sync,
            checksum: job.request.checksum,
            state: job.state,
            ...(job.error !== undefined ? { error: job.error } : {}),
            ...(job.result ? { result: job.result } : {}),
          }));
          emit({ jobs }, () => {
            if (jobs.length === 0) {
              note("队列为空");
              return;
            }
            for (const job of jobs) {
              printKeyValues([
                [
                  job.id,
                  `${job.direction} ${STATE_LABEL[job.state] ?? job.state} → ${job.destination}`,
                ],
              ]);
            }
          });
          return 0;
        } finally {
          await release();
        }
      }),
    );

  queue
    .command("resume <jobId>")
    .description("恢复已暂停/已取消的任务并等待完成（需实例运行中，不自动开机）")
    .action(
      action(async (context, jobId: string, _options: unknown, command: Command) => {
        const { queue: transferQueue, release } = queueFor(context, command);
        try {
          transferQueue.resume(jobId);
          const done = await waitForJob(transferQueue, jobId);
          if (done.state !== "completed") {
            throw new AutoDLError(
              `任务 ${jobId} 未完成（${STATE_LABEL[done.state] ?? done.state}${done.error ? `：${done.error}` : ""}）`,
            );
          }
          emit({ jobId, resumed: true, ...done }, () => success(`已恢复 ${jobId}`));
          return 0;
        } finally {
          await release();
        }
      }),
    );

  queue
    .command("cancel <jobId>")
    .description("取消排队/传输中的任务（保留续传数据）")
    .action(
      action(async (context, jobId: string, _options: unknown, command: Command) => {
        const { queue: transferQueue, release } = queueFor(context, command);
        try {
          transferQueue.cancel(jobId);
          emit({ jobId, cancelled: true }, () => success(`已取消 ${jobId}`));
          return 0;
        } finally {
          await release();
        }
      }),
    );

  queue
    .command("resolve <jobId> <choice>")
    .description("处理任务的文件冲突：overwrite / skip / keep-both")
    .option("--all", "应用于本任务其余冲突", false)
    .action(
      action(
        async (
          context,
          jobId: string,
          choice: string,
          options: { all: boolean },
          command: Command,
        ) => {
          if (choice !== "overwrite" && choice !== "skip" && choice !== "keep-both") {
            throw new UsageError("choice 必须是 overwrite / skip / keep-both");
          }
          const { queue: transferQueue, release } = queueFor(context, command);
          try {
            transferQueue.resolveConflict(jobId, { choice, applyToAll: options.all });
            const done = await waitForJob(transferQueue, jobId);
            if (done.state !== "completed") {
              throw new AutoDLError(
                `任务 ${jobId} 未完成（${STATE_LABEL[done.state] ?? done.state}${done.error ? `：${done.error}` : ""}）`,
              );
            }
            emit({ jobId, choice, applyToAll: options.all, ...done }, () =>
              success(`已处理冲突：${choice}`),
            );
            return 0;
          } finally {
            await release();
          }
        },
      ),
    );
}

async function waitForJob(
  queue: TransferQueue,
  jobId: string,
): Promise<{ state: string; error?: string }> {
  const { promise, resolve } = Promise.withResolvers<{ state: string; error?: string }>();
  const done = (state: string, error?: string) =>
    resolve(error === undefined ? { state } : { state, error });
  const check = (): boolean => {
    const job = queue.snapshot().find((entry) => entry.request.id === jobId);
    if (!job) {
      done("missing", "任务不存在");
      return true;
    }
    if (job.state === "completed" || job.state === "cancelled") {
      done(job.state, job.error);
      return true;
    }
    if (job.state === "paused") {
      done(job.state, job.error ?? "任务已暂停");
      return true;
    }
    if (job.state === "conflict") {
      // No prompt in the CLI: the holder answers via `queue resolve` (same
      // process or another), which resumes the job and wakes this waiter.
      done(job.state, job.error ?? "任务等待冲突确认（用 queue resolve 回答）");
      return true;
    }
    return false;
  };
  if (check()) return promise;
  const unsubscribe = queue.subscribe(() => {
    if (check()) unsubscribe();
  });
  if (check()) unsubscribe();
  return promise;
}
