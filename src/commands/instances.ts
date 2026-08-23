import { spinner } from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { untrackInstance } from "../config/state.js";
import {
  assertProCreateRegion,
  DEFAULT_BASE_IMAGE,
  findBaseImage,
  parseCudaVersion,
  resolveGpuSpec,
} from "../core/catalog.js";
import { formatDuration, parseDuration } from "../core/duration.js";
import {
  createInstance,
  findInstance,
  getInstanceSnapshot,
  getInstanceStatus,
  listAllInstances,
  powerOffInstance,
  powerOnInstance,
  releaseInstance,
} from "../core/endpoints/instance.js";
import { UsageError } from "../core/errors.js";
import { formatRate } from "../core/money.js";
import { chooseRegions } from "../core/stock.js";
import { waitForRunning, waitForShutdown } from "../core/waiters.js";
import { assertBudget } from "../guard/budget.js";
import { armTTLOverSSH, composeStartCommand, recordTTL } from "../guard/ttl.js";
import {
  colorStatus,
  emit,
  formatBytes,
  formatTime,
  isJson,
  note,
  printKeyValues,
  printTable,
  success,
  warn,
} from "../output/format.js";
import { t } from "../output/i18n.js";
import { action, confirmDestructive } from "./helpers.js";

interface CreateOptions {
  gpu: string;
  num: string;
  image?: string;
  cuda?: string;
  region?: string[];
  disk: string;
  name?: string;
  ttl?: string;
  startCommand?: string;
  minBalance?: string;
  wait?: boolean;
  stockCheck?: boolean;
}

export function registerInstanceCommands(program: Command): void {
  program
    .command("ls")
    .alias("list")
    .description("列出账号下的所有实例")
    .option("--status <status>", "按状态过滤，如 running / shutdown")
    .action(
      action(async (context, options: { status?: string }) => {
        let instances = await listAllInstances(context.client);
        if (options.status) {
          instances = instances.filter((instance) => instance.status === options.status);
        }
        emit(instances, () => {
          if (instances.length === 0) {
            note(t("instance.none"));
            return;
          }
          printTable(
            ["实例 ID", "名称", "状态", "GPU", "地区", "创建时间"],
            instances.map((instance) => [
              instance.uuid,
              instance.name ?? "-",
              colorStatus(instance.status),
              `${instance.gpuSpec ?? "-"} ×${instance.gpuNum}`,
              instance.regionName ?? instance.regionSign ?? "-",
              formatTime(instance.createdAt),
            ]),
          );
        });
        return 0;
      }),
    );

  program
    .command("info <id>")
    .description("查看实例详情，含 SSH 连接信息")
    .option("--show-password", "在输出中显示 root 密码明文", false)
    .action(
      action(async (context, id: string, options: { showPassword: boolean }) => {
        const [instance, snapshot] = await Promise.all([
          findInstance(context.client, id),
          getInstanceSnapshot(context.client, id).catch(() => null),
        ]);

        const payload = {
          instance,
          snapshot:
            snapshot && !options.showPassword
              ? {
                  ...snapshot,
                  ssh: { ...snapshot.ssh, password: snapshot.ssh.password ? "***" : null },
                }
              : snapshot,
        };

        emit(payload, () => {
          printKeyValues([
            ["实例 ID", instance.uuid],
            ["名称", instance.name ?? "-"],
            ["状态", colorStatus(instance.status)],
            ["GPU", `${instance.gpuSpec ?? "-"} ×${instance.gpuNum}`],
            ["地区", instance.regionName ?? instance.regionSign ?? "-"],
            ["计费方式", instance.chargeType ?? "-"],
            ["创建时间", formatTime(instance.createdAt)],
            ["开机时间", formatTime(instance.startedAt)],
          ]);

          if (!snapshot) {
            note(pc.dim("\n实例未运行，暂无 SSH 信息。"));
            return;
          }

          process.stdout.write("\n");
          printKeyValues([
            ["单价", snapshot.priceYuanPerHour ? formatRate(snapshot.priceYuanPerHour) : "-"],
            ["SSH", snapshot.ssh.command ?? "-"],
            [
              "密码",
              options.showPassword
                ? (snapshot.ssh.password ?? "-")
                : pc.dim("*** (加 --show-password 显示)"),
            ],
            [
              "CPU",
              snapshot.usage.cpuPercent !== null ? `${snapshot.usage.cpuPercent.toFixed(1)}%` : "-",
            ],
            [
              "内存",
              snapshot.usage.memUsedBytes !== null
                ? `${formatBytes(snapshot.usage.memUsedBytes)} / ${formatBytes(snapshot.usage.memLimitBytes)}`
                : "-",
            ],
            [
              "系统盘",
              snapshot.usage.rootFsUsedBytes !== null
                ? `${formatBytes(snapshot.usage.rootFsUsedBytes)} / ${formatBytes(snapshot.usage.rootFsTotalBytes)}`
                : "-",
            ],
          ]);

          if (snapshot.services.length) {
            process.stdout.write("\n");
            printTable(
              ["端口", "协议", "外部地址"],
              snapshot.services.map((service) => [
                service.port,
                service.protocol ?? "-",
                service.domain,
              ]),
            );
          }
        });
        return 0;
      }),
    );

  program
    .command("create")
    .description("创建一个按量计费的 Pro 实例")
    .requiredOption("--gpu <spec>", "GPU 规格，可用 `autodl gpus` 查看")
    .option("--num <n>", "GPU 数量（1-4）", "1")
    .option("--image <uuid>", "镜像 UUID 或公共镜像标签", DEFAULT_BASE_IMAGE)
    .option("--cuda <version>", "最低 CUDA 版本，如 11.8")
    .option("--region <code...>", "优先地区，可多次指定")
    .option("--disk <gb>", "系统盘扩容 GB（0-500）", "0")
    .option("--name <name>", "实例名称")
    .option("--ttl <duration>", "到期自动关机，如 2h / 90m（强烈建议设置）")
    .option("--start-command <cmd>", "开机后执行的命令")
    .option("--min-balance <yuan>", "余额低于该值时拒绝创建")
    .option("--wait", "等待实例进入 running 状态", false)
    .option("--no-stock-check", "跳过创建前的 GPU 库存查询")
    .action(
      action(async (context, options: CreateOptions) => {
        const spec = resolveGpuSpec(options.gpu);
        if (!spec) {
          throw new UsageError(`未知的 GPU 规格 "${options.gpu}"`, {
            hint: "运行 `autodl gpus` 查看官方 API 支持的全部规格。",
          });
        }

        const image = findBaseImage(options.image ?? DEFAULT_BASE_IMAGE);
        const imageUuid = image?.uuid ?? options.image ?? DEFAULT_BASE_IMAGE;
        const cudaFrom = options.cuda
          ? parseCudaVersion(options.cuda)
          : parseCudaVersion(image?.cuda ?? "11.8");

        // Pro creation accepts only two regions; anything else fails opaquely upstream.
        const requestedRegions = (options.region ?? []).map(
          (input) => assertProCreateRegion(input).id,
        );

        // Stock is advisory ranking only — see chooseRegions.
        const regions =
          options.stockCheck === false
            ? requestedRegions
            : (await chooseRegions(context.client, spec, requestedRegions)).regions;

        const ttlSeconds = options.ttl ? parseDuration(options.ttl) : undefined;
        if (!ttlSeconds) {
          warn(
            "未设置 --ttl：实例会一直计费直到手动关机。AutoDL 按开机时长计费，与是否使用 GPU 无关。",
          );
        }

        await assertBudget(
          context.client,
          options.minBalance !== undefined ? Number(options.minBalance) : undefined,
        );

        const startCommand = composeStartCommand(ttlSeconds, options.startCommand);

        const spin = isJson() ? null : spinner();
        spin?.start(t("instance.creating"));
        let uuid: string;
        try {
          uuid = await createInstance(context.client, {
            gpuSpec: spec.id,
            gpuNum: Number(options.num),
            imageUuid,
            cudaFrom,
            expandSystemDiskGb: Number(options.disk),
            ...(regions.length ? { regions } : {}),
            ...(options.name ? { name: options.name } : {}),
            ...(startCommand ? { startCommand } : {}),
          });
        } catch (err) {
          spin?.stop("创建失败", 1);
          throw err;
        }
        spin?.stop(`${t("instance.created")}：${uuid}`);

        if (ttlSeconds) {
          recordTTL({
            uuid,
            ...(options.name ? { name: options.name } : {}),
            ttlSeconds,
            inInstanceTimer: true,
          });
        }

        let status = "creating";
        if (options.wait) {
          const waitSpin = isJson() ? null : spinner();
          waitSpin?.start(t("instance.waiting"));
          status = await waitForRunning(context.client, uuid);
          waitSpin?.stop(t("instance.ready"));
        }

        emit(
          {
            uuid,
            gpuSpec: spec.id,
            gpuNum: Number(options.num),
            imageUuid,
            cudaFrom,
            regions,
            ttlSeconds: ttlSeconds ?? null,
            status,
          },
          () => {
            success(`实例 ${pc.bold(uuid)} 已创建`);
            if (ttlSeconds) note(`${t("guard.armed")}：${formatDuration(ttlSeconds)} 后自动关机`);
            note(`连接：autodl ssh ${uuid}`);
          },
        );
        return 0;
      }),
    );

  program
    .command("start <id>")
    .description("开机")
    .option("--ttl <duration>", "开机后设置到期自动关机")
    .option("--start-command <cmd>", "开机后执行的命令")
    .option("--wait", "等待实例进入 running 状态", false)
    .action(
      action(
        async (
          context,
          id: string,
          options: { ttl?: string; startCommand?: string; wait: boolean },
        ) => {
          const ttlSeconds = options.ttl ? parseDuration(options.ttl) : undefined;
          const startCommand = composeStartCommand(ttlSeconds, options.startCommand);

          note(t("instance.poweringOn"));
          await powerOnInstance(context.client, id, {
            ...(startCommand ? { startCommand } : {}),
          });

          let armed = Boolean(ttlSeconds);
          if (options.wait || ttlSeconds) {
            const spin = isJson() ? null : spinner();
            spin?.start(t("instance.waiting"));
            await waitForRunning(context.client, id);
            spin?.stop(t("instance.ready"));

            if (ttlSeconds) {
              // start_command only runs on a cold boot; re-arming over SSH covers the
              // case where AutoDL reused a warm container and skipped it.
              armed = await armTTLOverSSH(context.client, id, ttlSeconds);
              if (!armed) warn(t("guard.armFailed"));
              recordTTL({ uuid: id, ttlSeconds, inInstanceTimer: armed });
            }
          }

          emit(
            { uuid: id, started: true, ttlSeconds: ttlSeconds ?? null, inInstanceTimer: armed },
            () => {
              success(`实例 ${id} 已开机`);
              if (ttlSeconds) note(`${t("guard.armed")}：${formatDuration(ttlSeconds)} 后自动关机`);
            },
          );
          return 0;
        },
      ),
    );

  program
    .command("stop <id>")
    .description("关机（停止计费，数据保留）")
    .action(
      action(async (context, id: string) => {
        note(t("instance.poweringOff"));
        await powerOffInstance(context.client, id);
        untrackInstance(id);
        emit({ uuid: id, stopped: true }, () => success(`实例 ${id} 已关机，计费已停止`));
        return 0;
      }),
    );

  program
    .command("rm <id>")
    .alias("release")
    .description("释放实例（不可逆，数据将被永久清空）")
    .option("-y, --yes", "跳过确认", false)
    .option("--force", "若实例仍在运行则先自动关机", false)
    .action(
      action(async (context, id: string, options: { yes: boolean; force: boolean }) => {
        const status = await getInstanceStatus(context.client, id);
        if (status !== "shutdown") {
          if (!options.force) {
            throw new UsageError(`实例当前状态为 "${status}"，AutoDL 要求先关机才能释放`, {
              hint: "先运行 `autodl stop <id>`，或加 --force 让本命令自动关机。",
            });
          }
          // A second power_off on an already-stopping instance is an error
          // ("当前实例正在关机中,无需重复操作"), so only send it when it can act.
          if (status !== "shutting_down") {
            note(t("instance.poweringOff"));
            await powerOffInstance(context.client, id);
          }
          // AutoDL also refuses a release until the shutdown has finished.
          await waitForShutdown(context.client, id, { timeoutMs: 10 * 60_000 });
        }

        const confirmed = await confirmDestructive(
          `${t("instance.confirmRelease")} ${id}`,
          options.yes,
        );
        if (!confirmed) {
          emit({ uuid: id, released: false, cancelled: true }, () => note(t("common.cancelled")));
          return 0;
        }

        await releaseInstance(context.client, id);
        untrackInstance(id);
        emit({ uuid: id, released: true }, () => success(`${t("instance.released")}：${id}`));
        return 0;
      }),
    );
}
