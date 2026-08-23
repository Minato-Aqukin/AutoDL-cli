import { z } from "zod";
import { milliToYuan } from "./money.js";

/**
 * AutoDL wraps nullable timestamps in Go's `sql.NullTime` shape. We flatten those to
 * `string | null` before anything above `core/` sees them.
 */
const nullTime = z
  .object({ Time: z.string(), Valid: z.boolean() })
  .transform((v) => (v.Valid ? v.Time : null));

const maybeTime = z.union([nullTime, z.string(), z.null()]).transform((v) => v ?? null);

export const instanceStatusSchema = z.enum([
  "creating",
  "starting",
  "running",
  "shutting_down",
  "shutdown",
  "releasing",
  "released",
  "failed",
]);
/** AutoDL may add states we don't know yet; keep unknown values rather than throwing. */
export const looseStatusSchema = z.string();

export type InstanceStatus = z.infer<typeof instanceStatusSchema> | (string & {});

export const rawInstanceSchema = z
  .object({
    uuid: z.string(),
    name: z.string().nullish(),
    status: z.string(),
    sub_status: z.string().nullish(),
    machine_id: z.string().nullish(),
    machine_alias: z.string().nullish(),
    region_sign: z.string().nullish(),
    region_name: z.string().nullish(),
    charge_type: z.string().nullish(),
    start_mode: z.string().nullish(),
    req_gpu_amount: z.number().nullish(),
    gpu_spec_uuid: z.string().nullish(),
    created_at: maybeTime.nullish(),
    status_at: maybeTime.nullish(),
    started_at: maybeTime.nullish(),
    stopped_at: maybeTime.nullish(),
    expired_at: maybeTime.nullish(),
    timed_shutdown_at: maybeTime.nullish(),
  })
  .passthrough();

/** Public, stable shape returned by `autodl ls --json`. Breaking changes need a major. */
export interface Instance {
  uuid: string;
  name: string | null;
  status: InstanceStatus;
  subStatus: string | null;
  machineId: string | null;
  regionSign: string | null;
  regionName: string | null;
  chargeType: string | null;
  startMode: string | null;
  gpuSpec: string | null;
  gpuNum: number;
  createdAt: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  expiredAt: string | null;
  timedShutdownAt: string | null;
}

export function normalizeInstance(raw: unknown): Instance {
  const v = rawInstanceSchema.parse(raw);
  return {
    uuid: v.uuid,
    name: v.name ?? null,
    status: v.status,
    subStatus: v.sub_status || null,
    machineId: v.machine_id || null,
    regionSign: v.region_sign || null,
    regionName: v.region_name || null,
    chargeType: v.charge_type || null,
    startMode: v.start_mode || null,
    gpuSpec: v.gpu_spec_uuid || null,
    gpuNum: v.req_gpu_amount ?? 0,
    createdAt: v.created_at ?? null,
    startedAt: v.started_at ?? null,
    stoppedAt: v.stopped_at ?? null,
    expiredAt: v.expired_at ?? null,
    timedShutdownAt: v.timed_shutdown_at ?? null,
  };
}

const usageInfoSchema = z
  .object({
    container_id: z.string().nullish(),
    cpu_usage_percent: z.number().nullish(),
    mem_usage_percent: z.number().nullish(),
    mem_usage: z.number().nullish(),
    mem_limit: z.number().nullish(),
    root_fs_used_size: z.number().nullish(),
    root_fs_total_size: z.number().nullish(),
    data_disk_used_size: z.number().nullish(),
    data_disk_total_size: z.number().nullish(),
  })
  .passthrough();

export const rawSnapshotSchema = z
  .object({
    region_sign: z.string().nullish(),
    payg_price: z.number().nullish(),
    origin_pay_price: z.number().nullish(),
    snapshot_gpu_alias_name: z.string().nullish(),
    chip_corp: z.string().nullish(),
    cpu_arch: z.string().nullish(),
    ssh_command: z.string().nullish(),
    proxy_host: z.string().nullish(),
    root_password: z.string().nullish(),
    ssh_port: z.number().nullish(),
    jupyter_token: z.string().nullish(),
    jupyter_domain: z.string().nullish(),
    expand_system_disk_size: z.number().nullish(),
    system_init_disk_size: z.number().nullish(),
    usage_info: usageInfoSchema.nullish(),
  })
  .passthrough();

export interface ServiceEndpoint {
  port: number;
  domain: string;
  protocol: string | null;
}

/** Public shape for `autodl info --json`. `rootPassword` is sensitive — see redaction. */
export interface InstanceSnapshot {
  regionSign: string | null;
  gpuAlias: string | null;
  chipCorp: string | null;
  cpuArch: string | null;
  /** Pay-as-you-go rate in yuan per hour. */
  priceYuanPerHour: number;
  originalPriceYuanPerHour: number;
  ssh: {
    command: string | null;
    host: string | null;
    port: number | null;
    user: "root";
    password: string | null;
  };
  jupyter: { token: string | null; domain: string | null };
  services: ServiceEndpoint[];
  disk: { systemInitBytes: number; systemExpandBytes: number };
  usage: {
    cpuPercent: number | null;
    memPercent: number | null;
    memUsedBytes: number | null;
    memLimitBytes: number | null;
    rootFsUsedBytes: number | null;
    rootFsTotalBytes: number | null;
    dataDiskUsedBytes: number | null;
    dataDiskTotalBytes: number | null;
  };
}

const SERVICE_DOMAIN = /^service_(\d+)_domain$/;

export function normalizeSnapshot(raw: unknown): InstanceSnapshot {
  const v = rawSnapshotSchema.parse(raw);
  const bag = raw as Record<string, unknown>;

  const services: ServiceEndpoint[] = [];
  for (const [key, value] of Object.entries(bag)) {
    const match = SERVICE_DOMAIN.exec(key);
    if (!match || typeof value !== "string" || !value) continue;
    const port = Number(match[1]);
    const protocol = bag[`service_${port}_port_protocol`];
    services.push({
      port,
      domain: value,
      protocol: typeof protocol === "string" && protocol ? protocol : null,
    });
  }
  services.sort((a, b) => a.port - b.port);

  const usage = v.usage_info ?? {};
  return {
    regionSign: v.region_sign || null,
    gpuAlias: v.snapshot_gpu_alias_name || null,
    chipCorp: v.chip_corp || null,
    cpuArch: v.cpu_arch || null,
    priceYuanPerHour: milliToYuan(v.payg_price),
    originalPriceYuanPerHour: milliToYuan(v.origin_pay_price),
    ssh: {
      command: v.ssh_command || null,
      host: v.proxy_host || null,
      port: v.ssh_port ?? null,
      user: "root",
      password: v.root_password || null,
    },
    jupyter: { token: v.jupyter_token || null, domain: v.jupyter_domain || null },
    services,
    disk: {
      systemInitBytes: v.system_init_disk_size ?? 0,
      systemExpandBytes: v.expand_system_disk_size ?? 0,
    },
    usage: {
      cpuPercent: usage.cpu_usage_percent ?? null,
      memPercent: usage.mem_usage_percent ?? null,
      memUsedBytes: usage.mem_usage ?? null,
      memLimitBytes: usage.mem_limit ?? null,
      rootFsUsedBytes: usage.root_fs_used_size ?? null,
      rootFsTotalBytes: usage.root_fs_total_size ?? null,
      dataDiskUsedBytes: usage.data_disk_used_size ?? null,
      dataDiskTotalBytes: usage.data_disk_total_size ?? null,
    },
  };
}

export const rawBalanceSchema = z
  .object({
    assets: z.number().nullish(),
    accumulate: z.number().nullish(),
    voucher_balance: z.number().nullish(),
  })
  .passthrough();

export interface Balance {
  /** Spendable balance in yuan. */
  balanceYuan: number;
  /** Lifetime spend in yuan. */
  accumulatedYuan: number;
  /** Voucher balance in yuan. */
  voucherYuan: number;
}

export function normalizeBalance(raw: unknown): Balance {
  const v = rawBalanceSchema.parse(raw);
  return {
    balanceYuan: milliToYuan(v.assets),
    accumulatedYuan: milliToYuan(v.accumulate),
    voucherYuan: milliToYuan(v.voucher_balance),
  };
}

export const rawImageSchema = z
  .object({
    image_uuid: z.string(),
    name: z.string().nullish(),
    image_name: z.string().nullish(),
    status: z.string().nullish(),
    image_size: z.number().nullish(),
    create_at: z.string().nullish(),
    created_at: z.string().nullish(),
  })
  .passthrough();

export interface PrivateImage {
  imageUuid: string;
  name: string;
  status: string | null;
  sizeBytes: number;
  createdAt: string | null;
}

export function normalizeImage(raw: unknown): PrivateImage {
  const v = rawImageSchema.parse(raw);
  return {
    imageUuid: v.image_uuid,
    name: v.name ?? v.image_name ?? "",
    status: v.status ?? null,
    sizeBytes: v.image_size ?? 0,
    createdAt: v.create_at ?? v.created_at ?? null,
  };
}

export const paginationSchema = z
  .object({
    page_index: z.number().nullish(),
    page_size: z.number().nullish(),
    max_page: z.number().nullish(),
    result_total: z.number().nullish(),
  })
  .passthrough();

export interface Pagination {
  pageIndex: number;
  pageSize: number;
  maxPage: number;
  total: number;
}

export function normalizePagination(raw: unknown): Pagination {
  const v = paginationSchema.parse(raw ?? {});
  return {
    pageIndex: v.page_index ?? 1,
    pageSize: v.page_size ?? 0,
    maxPage: v.max_page ?? 1,
    total: v.result_total ?? 0,
  };
}

/** Strip secrets before printing a snapshot to a shared surface (logs, MCP previews). */
export function redactSnapshot(snapshot: InstanceSnapshot): InstanceSnapshot {
  return {
    ...snapshot,
    ssh: { ...snapshot.ssh, password: snapshot.ssh.password ? "***" : null },
    jupyter: { ...snapshot.jupyter, token: snapshot.jupyter.token ? "***" : null },
  };
}
