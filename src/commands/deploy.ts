import type { Command } from "commander";
import pc from "picocolors";
import { formatDuration, parseDuration } from "../core/duration.js";
import { resolveGitToken } from "../core/repo.js";
import { emit, note, success, warn } from "../output/format.js";
import { type DeployOptions, deployWorkflow } from "../workflow/deploy.js";
import { action } from "./helpers.js";

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
  setup?: string;
  noSetup?: boolean;
  start?: string;
  detach: boolean;
  gitToken?: string;
  noAccel?: boolean;
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

        // Ctrl-C must still reach cleanup, or the instance keeps billing.
        const controller = new AbortController();
        let interrupted = false;
        const onSigint = () => {
          if (interrupted) return;
          interrupted = true;
          warn("收到中断信号，正在安全收尾…");
          controller.abort();
        };
        process.on("SIGINT", onSigint);
        process.on("SIGTERM", onSigint);

        try {
          const deployOptions: DeployOptions = {
            repo,
            ...(options.gpu ? { gpu: options.gpu } : {}),
            ...(options.instance ? { instanceUuid: options.instance } : {}),
            ...(options.branch ? { branch: options.branch } : {}),
            gpuNum: Number(options.num),
            ...(options.image ? { image: options.image } : {}),
            ...(options.region ? { regions: options.region } : {}),
            diskGb: Number(options.disk),
            ...(options.name ? { name: options.name } : {}),
            ...(options.dir ? { dir: options.dir } : {}),
            ...(options.setup ? { setup: options.setup } : {}),
            noSetup: options.noSetup === true,
            ...(options.start ? { start: options.start } : {}),
            detach: options.detach,
            ...(resolveGitToken(options.gitToken)
              ? { gitToken: resolveGitToken(options.gitToken) as string }
              : {}),
            noAcceleration: options.noAccel === true,
            ttlSeconds: parseDuration(options.ttl),
            onFinish: (["poweroff", "release", "keep"].includes(options.onFinish)
              ? options.onFinish
              : "poweroff") as DeployCliOptions["onFinish"],
            ...(options.timeout ? { commandTimeoutMs: parseDuration(options.timeout) * 1000 } : {}),
            ...(options.minBalance !== undefined
              ? { minBalanceYuan: Number(options.minBalance) }
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

          return result.startCommand && !result.detached ? (result.exitCode ?? 1) : 0;
        } finally {
          process.off("SIGINT", onSigint);
          process.off("SIGTERM", onSigint);
        }
      }),
    );
}
