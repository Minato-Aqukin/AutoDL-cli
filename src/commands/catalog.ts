import type { Command } from "commander";
import pc from "picocolors";
import { BASE_IMAGES, GPU_SPECS, REGIONS } from "../core/catalog.js";
import { listPrivateImages } from "../core/endpoints/image.js";
import { emit, formatBytes, formatTime, note, printTable } from "../output/format.js";
import { lazyAction } from "./helpers.js";

export function registerCatalogCommands(program: Command): void {
  program
    .command("gpus")
    .description("列出官方开放 API 支持的 GPU 规格")
    .action(
      lazyAction(async () => {
        emit([...GPU_SPECS], () => {
          printTable(
            ["规格 ID", "型号", "类型", "显存", "别名"],
            GPU_SPECS.map((spec) => [
              spec.id,
              spec.displayName,
              spec.tier === "general" ? "通用型" : "性能型",
              `${spec.vramGb}G`,
              spec.aliases.join(", "),
            ]),
          );
          note(
            pc.dim(
              "官方 API 没有库存查询接口，创建实例只能直接尝试；无货时会返回 NO_STOCK（退出码 6）。",
            ),
          );
        });
        return 0;
      }),
    );

  program
    .command("regions")
    .description("列出可用地区代码")
    .action(
      lazyAction(async () => {
        emit([...REGIONS], () => {
          printTable(
            ["地区代码", "名称", "别名"],
            REGIONS.map((region) => [region.id, region.displayName, region.aliases.join(", ")]),
          );
        });
        return 0;
      }),
    );

  program
    .command("images")
    .description("列出镜像（默认显示私有镜像，--base 显示官方公共基础镜像）")
    .option("--base", "显示官方公共基础镜像")
    .option("--page <n>", "页码", "1")
    .option("--page-size <n>", "每页条数", "50")
    .action(
      lazyAction(
        async (getContext, options: { base?: boolean; page: string; pageSize: string }) => {
          if (options.base) {
            emit([...BASE_IMAGES], () => {
              printTable(
                ["镜像 UUID", "框架", "CUDA", "Python", "标签"],
                BASE_IMAGES.map((image) => [
                  image.uuid,
                  image.framework,
                  image.cuda,
                  image.python,
                  image.tag,
                ]),
              );
              note(pc.dim("这些是内置的静态表，若平台已更新请到仓库提 issue。"));
            });
            return 0;
          }

          const { images, pagination } = await listPrivateImages(getContext().client, {
            pageIndex: Number(options.page),
            pageSize: Number(options.pageSize),
          });
          emit({ images, pagination }, () => {
            if (images.length === 0) {
              note("当前账号没有私有镜像");
              return;
            }
            printTable(
              ["镜像 UUID", "名称", "状态", "大小", "创建时间"],
              images.map((image) => [
                image.imageUuid,
                image.name,
                image.status ?? "-",
                formatBytes(image.sizeBytes),
                formatTime(image.createdAt),
              ]),
            );
          });
          return 0;
        },
      ),
    );
}
