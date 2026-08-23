import type { Command } from "commander";
import { formatDuration, parseDuration } from "../core/duration.js";
import { emit, note, success, warn } from "../output/format.js";
import { runWorkflow } from "../workflow/run.js";
import { action } from "./helpers.js";

interface RunCliOptions {
  gpu: string;
  num: string;
  image?: string;
  cuda?: string;
  region?: string[];
  disk: string;
  name?: string;
  ttl: string;
  sync?: string;
  workdir?: string;
  pull?: string;
  pullTo?: string;
  onFinish: "poweroff" | "release" | "keep";
  timeout?: string;
  minBalance?: string;
  env?: string[];
}

export function registerRunCommand(program: Command): void {
  program
    .command("run <command...>")
    .description("一键工作流：建实例 → 同步代码 → 远程执行 → 回传产物 → 自动关机")
    .requiredOption("--gpu <spec>", "GPU 规格，可用 `autodl gpus` 查看")
    .option("--num <n>", "GPU 数量（1-4）", "1")
    .option("--image <uuid>", "镜像 UUID 或公共镜像标签")
    .option("--cuda <version>", "最低 CUDA 版本，如 11.8")
    .option("--region <code...>", "优先地区")
    .option("--disk <gb>", "系统盘扩容 GB", "0")
    .option("--name <name>", "实例名称")
    .option("--ttl <duration>", "到期自动关机（兜底保护，默认 4h）", "4h")
    .option("--sync <dir>", "执行前上传的本地目录")
    .option("--workdir <dir>", "远程工作目录", "/root/autodl-cli")
    .option("--pull <remote>", "执行后回传的远程路径")
    .option("--pull-to <local>", "回传产物的本地目录", "./autodl-output")
    .option("--on-finish <action>", "结束后动作：poweroff / release / keep", "poweroff")
    .option("--timeout <duration>", "远程命令超时时间")
    .option("--min-balance <yuan>", "余额低于该值时拒绝创建")
    .option("--env <key=value...>", "注入环境变量")
    .action(
      action(async (context, commandParts: string[], options: RunCliOptions) => {
        const command = commandParts.join(" ");
        const env: Record<string, string> = {};
        for (const pair of options.env ?? []) {
          const index = pair.indexOf("=");
          if (index > 0) env[pair.slice(0, index)] = pair.slice(index + 1);
        }

        if (!["poweroff", "release", "keep"].includes(options.onFinish)) {
          warn(`未知的 --on-finish "${options.onFinish}"，按 poweroff 处理`);
        }

        // Ctrl-C must still reach cleanup: abort the in-flight work and let
        // runWorkflow's finally block power the instance down.
        const controller = new AbortController();
        let interrupted = false;
        const onSigint = () => {
          if (interrupted) return;
          interrupted = true;
          warn("收到中断信号，正在安全收尾（实例将被关机）…");
          controller.abort();
        };
        process.on("SIGINT", onSigint);
        process.on("SIGTERM", onSigint);

        try {
          const result = await runWorkflow(context.client, {
            command,
            gpu: options.gpu,
            gpuNum: Number(options.num),
            ...(options.image ? { image: options.image } : {}),
            ...(options.cuda ? { cudaFrom: options.cuda } : {}),
            ...(options.region ? { regions: options.region } : {}),
            diskGb: Number(options.disk),
            ...(options.name ? { name: options.name } : {}),
            ttlSeconds: parseDuration(options.ttl),
            ...(options.sync ? { sync: options.sync } : {}),
            ...(options.workdir ? { workdir: options.workdir } : {}),
            ...(options.pull ? { pullFrom: options.pull } : {}),
            ...(options.pullTo ? { pullTo: options.pullTo } : {}),
            onFinish: (["poweroff", "release", "keep"].includes(options.onFinish)
              ? options.onFinish
              : "poweroff") as RunCliOptions["onFinish"],
            ...(options.timeout ? { commandTimeoutMs: parseDuration(options.timeout) * 1000 } : {}),
            ...(options.minBalance !== undefined
              ? { minBalanceYuan: Number(options.minBalance) }
              : {}),
            ...(Object.keys(env).length ? { env } : {}),
            signal: controller.signal,
          });

          emit(result, () => {
            note(`用时 ${formatDuration(Math.round(result.durationMs / 1000))}`);
            if (result.exitCode === 0) success("远程命令执行成功");
            else warn(`远程命令退出码 ${result.exitCode}`);
          });
          return result.exitCode ?? 1;
        } finally {
          process.off("SIGINT", onSigint);
          process.off("SIGTERM", onSigint);
        }
      }),
    );
}
