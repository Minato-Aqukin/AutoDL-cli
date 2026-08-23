import type { Command } from "commander";
import pc from "picocolors";
import { listTracked } from "../config/state.js";
import { formatDuration, parseDuration } from "../core/duration.js";
import { saveImage } from "../core/endpoints/image.js";
import { watchIdle } from "../guard/idle.js";
import { armTTLOverSSH, disarmTTLOverSSH, recordTTL, sweepExpired } from "../guard/ttl.js";
import { emit, note, printTable, success, warn } from "../output/format.js";
import { t } from "../output/i18n.js";
import { action, lazyAction } from "./helpers.js";

export function registerGuardCommands(program: Command): void {
  const guard = program.command("guard").description("成本护栏：定时关机、闲置检测、超时清理");

  guard
    .command("ttl <id> <duration>")
    .description("为运行中的实例设置到期自动关机，如 `autodl guard ttl pro-xxx 2h`")
    .action(
      action(async (context, id: string, duration: string) => {
        const seconds = parseDuration(duration);
        const armed = await armTTLOverSSH(context.client, id, seconds);
        recordTTL({ uuid: id, ttlSeconds: seconds, inInstanceTimer: armed });
        if (!armed) warn(t("guard.armFailed"));

        emit({ uuid: id, ttlSeconds: seconds, inInstanceTimer: armed }, () =>
          success(`${t("guard.armed")}：${formatDuration(seconds)} 后自动关机`),
        );
        return 0;
      }),
    );

  guard
    .command("cancel <id>")
    .description("取消实例内的定时关机")
    .action(
      action(async (context, id: string) => {
        const ok = await disarmTTLOverSSH(context.client, id);
        emit({ uuid: id, cancelled: ok }, () =>
          ok ? success("已取消定时关机") : warn("未能确认取消结果，请手动检查实例内定时任务"),
        );
        return 0;
      }),
    );

  guard
    .command("idle <id>")
    .description("持续采样 GPU 利用率，闲置足够久后自动关机")
    .option("--threshold <percent>", "判定为闲置的利用率上限", "5")
    .option("--samples <n>", "连续闲置多少次后关机", "6")
    .option("--interval <duration>", "采样间隔", "1m")
    .option("--dry-run", "只报告不关机", false)
    .action(
      action(
        async (
          context,
          id: string,
          options: { threshold: string; samples: string; interval: string; dryRun: boolean },
        ) => {
          const controller = new AbortController();
          const onSigint = () => controller.abort();
          process.once("SIGINT", onSigint);

          try {
            const result = await watchIdle(context.client, id, {
              thresholdPercent: Number(options.threshold),
              samples: Number(options.samples),
              intervalSeconds: parseDuration(options.interval),
              dryRun: options.dryRun,
              signal: controller.signal,
              onSample: (utilisation, consecutive) =>
                note(
                  pc.dim(
                    `GPU ${utilisation.toFixed(1)}%（连续闲置 ${consecutive}/${options.samples}）`,
                  ),
                ),
            });
            emit({ uuid: id, ...result }, () => {
              if (result.stopped) success(`实例 ${id} 因持续闲置已自动关机`);
              else note(`闲置检测结束：${result.reason}`);
            });
            return 0;
          } finally {
            process.off("SIGINT", onSigint);
          }
        },
      ),
    );

  guard
    .command("list")
    .description("列出本机记录的 TTL 台账")
    .action(
      lazyAction(async () => {
        const tracked = listTracked();
        emit(tracked, () => {
          if (tracked.length === 0) {
            note("本机没有记录任何带 TTL 的实例");
            return;
          }
          const now = Date.now();
          printTable(
            ["实例 ID", "名称", "TTL", "剩余", "实例内定时器"],
            tracked.map((entry) => [
              entry.uuid,
              entry.name ?? "-",
              formatDuration(entry.ttlSeconds),
              entry.expiresAt <= now
                ? pc.red("已超时")
                : formatDuration(Math.round((entry.expiresAt - now) / 1000)),
              entry.inInstanceTimer ? "已设置" : pc.yellow("未设置"),
            ]),
          );
        });
        return 0;
      }),
    );

  guard
    .command("sweep")
    .description("立即清理所有超时实例")
    .action(
      action(
        async (context) => {
          const result = await sweepExpired(context.client);
          emit(result, () => {
            if (result.stopped.length === 0 && result.failed.length === 0) {
              note("没有需要清理的超时实例");
              return;
            }
            if (result.stopped.length) success(`已关闭 ${result.stopped.length} 个超时实例`);
            for (const failure of result.failed) warn(`${failure.uuid}：${failure.reason}`);
          });
          return 0;
        },
        { sweep: false },
      ),
    );

  const image = program.command("image").description("镜像管理");

  image
    .command("save <id> <name>")
    .description("把实例保存为私有镜像")
    .action(
      action(async (context, id: string, name: string) => {
        const imageUuid = await saveImage(context.client, id, name);
        emit({ instanceUuid: id, imageUuid, name }, () =>
          success(
            `镜像保存已提交：${imageUuid}（保存需要一段时间，用 \`autodl images\` 查看状态）`,
          ),
        );
        return 0;
      }),
    );
}
