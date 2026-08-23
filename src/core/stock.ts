import { debug, note, warn } from "../output/format.js";
import {
  assertProCreateRegion,
  assertStockRegion,
  GPU_SPECS,
  type GpuSpec,
  REGIONS,
} from "./catalog.js";
import type { AutoDLClient } from "./client.js";
import { type GpuStockEntry, getRegionGpuStock } from "./endpoints/machine.js";

/**
 * Turn raw per-region stock into a ranked list of places to try.
 *
 * The stock endpoint belongs to elastic deployment, so a positive number is evidence
 * rather than a promise — measured 2026-08-23, it reported 140 idle RTX 4090D in a
 * region where Pro creation answered "暂无库存". Everything here is ordering advice
 * only; nothing refuses to create because a region looks empty.
 */

export interface RegionStock {
  regionId: string;
  regionName: string;
  idle: number;
  total: number;
}

export interface StockSnapshot {
  regionId: string;
  regionName: string;
  entries: GpuStockEntry[];
}

/** Query several regions at once; one region failing must not sink the rest. */
export async function getStockByRegion(
  client: AutoDLClient,
  options: { regions?: string[]; gpuNames?: string[] } = {},
): Promise<{ snapshots: StockSnapshot[]; failures: { regionId: string; reason: string }[] }> {
  const targets = (options.regions?.length ? options.regions : REGIONS.map((r) => r.id)).map(
    (input) => assertStockRegion(input),
  );

  const settled = await Promise.allSettled(
    targets.map(async (region) => ({
      region,
      entries: await getRegionGpuStock(client, {
        regionSign: region.id,
        ...(options.gpuNames?.length ? { gpuNames: options.gpuNames } : {}),
      }),
    })),
  );

  const snapshots: StockSnapshot[] = [];
  const failures: { regionId: string; reason: string }[] = [];

  settled.forEach((result, index) => {
    const region = targets[index];
    if (!region) return;
    if (result.status === "fulfilled") {
      snapshots.push({
        regionId: region.id,
        regionName: region.displayName,
        entries: result.value.entries,
      });
    } else {
      const reason = (result.reason as Error)?.message ?? String(result.reason);
      failures.push({ regionId: region.id, reason });
      debug(`查询 ${region.id} 库存失败：${reason}`);
    }
  });

  return { snapshots, failures };
}

/**
 * Regions that currently have the given GPU free, best first.
 *
 * Returns regions with `idle === 0` too (at the end), so callers can tell "queried and
 * everything is busy" apart from "the query failed" — those are different situations
 * and only one of them warrants a warning.
 */
export async function findRegionsWithStock(
  client: AutoDLClient,
  spec: GpuSpec,
  options: { regions?: string[] } = {},
): Promise<{ ranked: RegionStock[]; failures: { regionId: string; reason: string }[] }> {
  const { snapshots, failures } = await getStockByRegion(client, {
    ...(options.regions?.length ? { regions: options.regions } : {}),
    gpuNames: [spec.stockName],
  });

  const ranked: RegionStock[] = [];
  for (const snapshot of snapshots) {
    // Exact match: the stock namespace distinguishes vGPU-48GB from vGPU-48GB-350W, and
    // conflating them would send the user to a region holding a different card.
    const entry = snapshot.entries.find((e) => e.gpuName === spec.stockName);
    if (!entry) continue;
    ranked.push({
      regionId: snapshot.regionId,
      regionName: snapshot.regionName,
      idle: entry.idle,
      total: entry.total,
    });
  }

  ranked.sort((a, b) => b.idle - a.idle || b.total - a.total);
  return { ranked, failures };
}

/** Look up a spec by its stock-namespace name (inverse of `GpuSpec.stockName`). */
export function specForStockName(gpuName: string): GpuSpec | undefined {
  return GPU_SPECS.find((spec) => spec.stockName === gpuName);
}

export interface RegionChoice {
  /** Value for `data_center_list`; empty means "let AutoDL schedule anywhere". */
  regions: string[];
  ranked: RegionStock[];
  /** True when stock was consulted and every candidate region reported zero idle. */
  allBusy: boolean;
}

/**
 * Decide what to put in `data_center_list`.
 *
 * Deliberately does NOT narrow an unconstrained request. Two live findings drove this:
 *
 *  - Pro creation accepts only westDC3 and beijingDC2; the other nine regions are
 *    elastic-deployment only and hard-fail with `RequestParameterIsWrong`.
 *  - Stock numbers come from the elastic-deployment pool and do not track Pro
 *    availability. Measured 2026-08-23: stock reported 140 idle RTX 4090D in westDC3
 *    while Pro creation there answered "暂无库存" — and the same request with no region
 *    constraint succeeded, landing in beijingDC2.
 *
 * So an empty list (let AutoDL schedule) beats any list we could infer. When the user
 * does name regions we keep their choice, ordering by stock and warning if it looks
 * empty — a weak signal, but the only one available.
 */
export async function chooseRegions(
  client: AutoDLClient,
  spec: GpuSpec,
  requested?: string[],
): Promise<RegionChoice> {
  if (!requested?.length) {
    // Widest scheduling freedom, which is empirically the highest success rate.
    return { regions: [], ranked: [], allBusy: false };
  }

  const validated = requested.map((input) => assertProCreateRegion(input).id);

  const { ranked, failures } = await findRegionsWithStock(client, spec, { regions: validated });
  for (const failure of failures) debug(`库存查询失败 ${failure.regionId}：${failure.reason}`);

  const withStock = ranked.filter((region) => region.idle > 0);

  if (withStock.length === 0 && ranked.length > 0) {
    warn(
      `${spec.displayName} 在指定地区的弹性部署库存为 0，仍会尝试创建（该库存不反映 Pro 实例可用量，仅供参考）`,
    );
    return { regions: validated, ranked, allBusy: true };
  }

  if (withStock.length > 0) {
    const best = withStock[0] as RegionStock;
    note(
      `指定地区中 ${best.regionName} 库存最多（${spec.displayName} 空闲 ${best.idle}/${best.total}）`,
    );
    // Keep every region the user asked for; only reorder.
    const ordered = [
      ...withStock.map((region) => region.regionId),
      ...validated.filter((id) => !withStock.some((region) => region.regionId === id)),
    ];
    return { regions: ordered, ranked, allBusy: false };
  }

  return { regions: validated, ranked, allBusy: false };
}
