import type { Command } from "commander";
import pc from "picocolors";
import { GPU_SPECS, PRO_CREATE_REGIONS, resolveGpuSpec, resolveRegion } from "../core/catalog.js";
import { UsageError } from "../core/errors.js";
import { getStockByRegion } from "../core/stock.js";
import { emit, note, printTable, warn } from "../output/format.js";
import { action } from "./helpers.js";

export function registerStockCommand(program: Command): void {
  program
    .command("stock")
    .description("查询各地区 GPU 实时库存（创建实例前看哪里有货）")
    .option("--gpu <spec>", "只看某个 GPU 规格，可用 `autodl gpus` 查看")
    .option("--region <code...>", "只看指定地区，默认查全部")
    .option("--all", "显示无货的地区与型号", false)
    .action(
      action(
        async (context, options: { gpu?: string; region?: string[]; all: boolean }) => {
          const spec = options.gpu ? resolveGpuSpec(options.gpu) : undefined;
          if (options.gpu && !spec) {
            throw new UsageError(`未知的 GPU 规格 "${options.gpu}"`, {
              hint: "运行 `autodl gpus` 查看官方 API 支持的全部规格。",
            });
          }

          const { snapshots, failures } = await getStockByRegion(context.client, {
            ...(options.region?.length ? { regions: options.region } : {}),
            ...(spec ? { gpuNames: [spec.stockName] } : {}),
          });

          // Only the seven Pro specs are rentable through the open API; everything else
          // the endpoint reports belongs to elastic deployment or standard instances.
          const rentable = new Map(GPU_SPECS.map((s) => [s.stockName, s]));

          const rows = snapshots.flatMap((snapshot) =>
            snapshot.entries
              .filter((entry) => options.all || entry.idle > 0)
              .map((entry) => ({
                regionId: snapshot.regionId,
                regionName: snapshot.regionName,
                gpuName: entry.gpuName,
                gpuSpec: rentable.get(entry.gpuName)?.id ?? null,
                // Only two regions accept a Pro instance; the rest are ESD-only.
                proCreate: resolveRegion(snapshot.regionId)?.proCreate ?? false,
                idle: entry.idle,
                total: entry.total,
              })),
          );
          rows.sort((a, b) => b.idle - a.idle);

          emit({ rows, failures }, () => {
            if (rows.length === 0) {
              note(
                spec ? `${spec.displayName} 当前在查询的地区均无空闲` : "查询范围内没有空闲 GPU",
              );
            } else {
              printTable(
                ["地区", "可建Pro", "GPU", "可租规格", "空闲", "总数"],
                rows.map((row) => [
                  row.regionName,
                  row.proCreate ? pc.green("是") : pc.dim("否"),
                  row.gpuName,
                  row.gpuSpec ? pc.green(row.gpuSpec) : pc.dim("—"),
                  row.idle === 0 ? pc.dim("0") : pc.bold(String(row.idle)),
                  row.total,
                ]),
              );
              note(
                pc.dim(
                  `「可建Pro」只有 ${PRO_CREATE_REGIONS.map((r) => r.displayName).join(" / ")} 为「是」，其余地区仅用于弹性部署，写进 --region 会被拒绝。`,
                ),
              );
              note(
                pc.dim(
                  "「可租规格」为空表示该型号无法通过官方开放 API 创建（只能开 Pro 实例的 7 个规格）。",
                ),
              );
              note(
                pc.yellow(
                  "注意：这些数字来自「弹性部署 GPU 库存」，不代表 Pro 实例的可用量——实测出现过库存显示 140 张空闲、Pro 创建却提示暂无库存的情况。仅供参考，不要据此判断创建一定失败。",
                ),
              );
              note(pc.dim("创建实例时不指定 --region，由 AutoDL 自行调度，成功率更高。"));
            }
            for (const failure of failures) warn(`${failure.regionId} 查询失败：${failure.reason}`);
          });
          return 0;
        },
        { sweep: false },
      ),
    );
}
