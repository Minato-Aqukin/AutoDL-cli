import { assertStockRegion } from "../catalog.js";
import type { AutoDLClient } from "../client.js";
import { yuanToMilli } from "../money.js";

/**
 * GPU stock, the only capacity-visibility endpoint AutoDL exposes.
 *
 * Officially titled "获取弹性部署GPU库存" — it belongs to the elastic-deployment product
 * line, not to Pro container instances. The returned names include Pro-only variants
 * (`vGPU-48GB-350W`, `RTX PRO 6000`, `H800`), which strongly suggests a shared physical
 * pool, but AutoDL makes no guarantee that "ESD has stock" means "creating a Pro
 * instance will succeed". Callers must treat this as advisory ranking, never as a gate.
 */

export interface GpuStockEntry {
  /** Stock-namespace GPU name, e.g. `RTX PRO 6000`. See `GpuSpec.stockName`. */
  gpuName: string;
  idle: number;
  total: number;
  /** Present in live responses though absent from the published docs. */
  chipCorp: string | null;
  cpuArch: string | null;
}

export interface StockQuery {
  /** Region id in the `data_center_list` namespace, e.g. `beijingDC2`. */
  regionSign: string;
  /** Restrict to these stock-namespace GPU names. */
  gpuNames?: string[];
  cudaFrom?: number;
  cudaTo?: number;
  cpuNumFrom?: number;
  cpuNumTo?: number;
  memorySizeFrom?: number;
  memorySizeTo?: number;
  /** Price bounds in yuan per hour; converted to AutoDL's milliyuan on the way out. */
  priceFromYuan?: number;
  priceToYuan?: number;
}

/** Raw shape: an array of single-key objects, one per GPU model. */
type RawStock = Record<
  string,
  { idle_gpu_num?: number; total_gpu_num?: number; chip_corp?: string; cpu_arch?: string }
>[];

export async function getRegionGpuStock(
  client: AutoDLClient,
  query: StockQuery,
): Promise<GpuStockEntry[]> {
  // A region from the wrong namespace comes back as an empty success, which would read
  // as "sold out". Reject it before it ever reaches the network.
  const region = assertStockRegion(query.regionSign);

  const payload: Record<string, unknown> = { region_sign: region.id };
  if (query.gpuNames?.length) payload.gpu_name_set = query.gpuNames;
  if (query.cudaFrom !== undefined) payload.cuda_v_from = query.cudaFrom;
  if (query.cudaTo !== undefined) payload.cuda_v_to = query.cudaTo;
  if (query.cpuNumFrom !== undefined) payload.cpu_num_from = query.cpuNumFrom;
  if (query.cpuNumTo !== undefined) payload.cpu_num_to = query.cpuNumTo;
  if (query.memorySizeFrom !== undefined) payload.memory_size_from = query.memorySizeFrom;
  if (query.memorySizeTo !== undefined) payload.memory_size_to = query.memorySizeTo;
  if (query.priceFromYuan !== undefined) payload.price_from = yuanToMilli(query.priceFromYuan);
  if (query.priceToYuan !== undefined) payload.price_to = yuanToMilli(query.priceToYuan);

  const data = await client.post<RawStock>("/api/v1/dev/machine/region/gpu_stock", payload);

  const entries: GpuStockEntry[] = [];
  for (const item of Array.isArray(data) ? data : []) {
    for (const [gpuName, value] of Object.entries(item ?? {})) {
      entries.push({
        gpuName,
        idle: value?.idle_gpu_num ?? 0,
        total: value?.total_gpu_num ?? 0,
        chipCorp: value?.chip_corp ?? null,
        cpuArch: value?.cpu_arch ?? null,
      });
    }
  }
  return entries;
}
