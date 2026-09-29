import type { Command } from "commander";
import pc from "picocolors";
import { formatDuration, parseDuration } from "../core/duration.js";
import { parseRepo, resolveGitToken } from "../core/repo.js";
import { emit, note, success, warn } from "../output/format.js";
import { type DeployOptions, deployWorkflow } from "../workflow/deploy.js";
import { action, parseNumericFlag } from "./helpers.js";

interface DeployCliOptions {
  gpu?: string;
  instance?: string;
  branch?: string;
  num: string;
  image?: string;
  region?: string[];
  disk: string;
  name?: string;
  dir?: string;
  // Commander folds `--no-setup` into `setup: false` (never a `noSetup` key) and
  // `--no-accel` into `accel: false`; see context.ts for the same `--no-sweep` trap.
  setup?: string | false;
  start?: string;
  detach: boolean;
  gitToken?: string;
  accel?: boolean;
  ttl: string;
  onFinish: "poweroff" | "release" | "keep";
  timeout?: string;
  minBalance?: string;
  stockCheck?: boolean;
  env?: string[];
}

export function registerDeployCommand(program: Command): void {
  program
    .command("deploy <repo>")
    .description(
      "开卡部署代码托管平台的项目：建实例 → 拉代码 → 装依赖 → 启动 →（默认）关机保留数据",
    )
    .option("--gpu <spec>", "GPU 规格；不指定 --instance 时必填")
    .option("--instance <id>", "复用已有实例：开机 → git pull → 重新部署")
    .option("--branch <name>", "分支或标签")
    .option("--dir <path>", "远程代码目录，默认 /root/autodl-tmp/<仓库名>")
    .option("--setup <cmd>", "自定义依赖安装命令，覆盖自动探测")
    .option("--no-setup", "跳过依赖安装")
    .option("--start <cmd>", "依赖装好后执行的启动命令")
    .option("--detach", "后台启动并立即返回（实例保持运行）", false)
    .option("--git-token <token>", "私有仓库凭证，也可用 GIT_TOKEN / GITHUB_TOKEN 环境变量")
    .option("--no-accel", "关闭学术资源加速")
    .option("--num <n>", "GPU 数量（1-4）", "1")
    .option("--image <uuid>", "镜像 UUID 或公共镜像标签")
    .option("--region <code...>", "限定地区，默认按库存自动择优")
    .option("--disk <gb>", "系统盘扩容 GB", "0")
    .option("--name <name>", "实例名称，默认取仓库名")
    .option("--ttl <duration>", "到期自动关机", "4h")
    .option("--on-finish <action>", "结束后动作：poweroff / release / keep", "poweroff")
    .option("--timeout <duration>", "单条远程命令超时时间")
    .option("--min-balance <yuan>", "余额低于该值时拒绝创建")
    .option("--no-stock-check", "跳过创建前的 GPU 库存查询")
    .option("--env <key=value...>", "注入环境变量")
    .action(
      action(async (context, repo: string, options: DeployCliOptions) => {
        const env: Record<string, string> = {};
        for (const pair of options.env ?? []) {
          const index = pair.indexOf("=");
          if (index > 0) env[pair.slice(0, index)] = pair.slice(index + 1);
        }

        if (!["poweroff", "release", "keep"].includes(options.onFinish)) {
          warn(`未知的 --on-finish "${options.onFinish}"，按 poweroff 处理`);
        }

        // Ctrl-C must still reach cleanup, or the instance keeps billing. The first
        // signal aborts the in-flight work; the handler then removes itself so a
        // second signal falls through to Node's default and force-quits.
        const controller = new AbortController();
        const onSignal = (): void => {
          process.off("SIGINT", onSignal);
          process.off("SIGTERM", onSignal);
          warn("收到中断信号，正在安全收尾…（再按一次 Ctrl-C 强制退出，但实例可能保持计费）");
          controller.abort();
        };
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);

        try {
          const repoHost = parseRepo(repo).host;
          const gitToken = resolveGitToken(options.gitToken, repoHost);
          const deployOptions: DeployOptions = {
            repo,
            ...(options.gpu ? { gpu: options.gpu } : {}),
            ...(options.instance ? { instanceUuid: options.instance } : {}),
            ...(options.branch ? { branch: options.branch } : {}),
            gpuNum: parseNumericFlag(options.num, "num", { integer: true, min: 1 }),
            ...(options.image ? { image: options.image } : {}),
            ...(options.region ? { regions: options.region } : {}),
            diskGb: parseNumericFlag(options.disk, "disk", { integer: true, min: 0 }),
            ...(options.name ? { name: options.name } : {}),
            ...(options.dir ? { dir: options.dir } : {}),
            ...(typeof options.setup === "string" ? { setup: options.setup } : {}),
            noSetup: options.setup === false,
            ...(options.start ? { start: options.start } : {}),
            detach: options.detach,
            ...(gitToken ? { gitToken } : {}),
            noAcceleration: options.accel === false,
            ttlSeconds: parseDuration(options.ttl),
            onFinish: (["poweroff", "release", "keep"].includes(options.onFinish)
              ? options.onFinish
              : "poweroff") as DeployCliOptions["onFinish"],
            ...(options.timeout ? { commandTimeoutMs: parseDuration(options.timeout) * 1000 } : {}),
            ...(options.minBalance !== undefined
              ? { minBalanceYuan: parseNumericFlag(options.minBalance, "min-balance", { min: 0 }) }
              : {}),
            ...(options.stockCheck === false ? { stockCheck: false } : {}),
            ...(Object.keys(env).length ? { env } : {}),
            signal: controller.signal,
          };

          const result = await deployWorkflow(context.client, deployOptions);

          emit(result, () => {
            note(`用时 ${formatDuration(Math.round(result.durationMs / 1000))}`);
            if (result.detached) {
              success("项目已在后台运行");
              for (const url of result.access.publicUrls) note(`  公网访问：${url}`);
              if (result.access.tunnelHint) {
                note(`  ${pc.dim("公网映射需企业认证，个人账号请用 SSH 隧道：")}`);
                note(`  ${result.access.tunnelHint}`);
              }
              if (result.access.logHint) note(`  查看日志：${result.access.logHint}`);
            } else if (result.startCommand) {
              if (result.exitCode === 0) success("项目执行成功");
              else warn(`项目退出码 ${result.exitCode}`);
            } else {
              success(`部署完成：${result.dir}`);
            }
            if (result.finalAction === "poweroff" && !result.detached) {
              note(`下次直接复用：autodl deploy ${repo} --instance ${result.instanceUuid}`);
            }
          });

          if (result.cleanup.error) {
            // finish() already warned with the instance id; the exit code is what an
            // agent branches on in --json/MCP mode, where warn() is silent.
            warn(
              `收尾清理未完成：${result.cleanup.error}（实例 ${result.instanceUuid} 可能仍在计费）`,
            );
            return 1;
          }
          return result.startCommand && !result.detached ? (result.exitCode ?? 1) : 0;
        } finally {
          process.off("SIGINT", onSignal);
          process.off("SIGTERM", onSignal);
        }
      }),
    );
}
