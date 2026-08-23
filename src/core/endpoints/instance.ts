import type { AutoDLClient } from "../client.js";
import { NotFoundError, UsageError } from "../errors.js";
import {
  type Instance,
  type InstanceSnapshot,
  normalizeInstance,
  normalizePagination,
  normalizeSnapshot,
  type Pagination,
} from "../schemas.js";

export interface CreateInstanceInput {
  /** `gpu_spec_uuid`, e.g. `pro6000-p`. Resolve aliases before calling. */
  gpuSpec: string;
  /** 1-4, enforced by AutoDL. */
  gpuNum: number;
  imageUuid: string;
  /** Integer CUDA floor, e.g. 118 for CUDA >= 11.8. */
  cudaFrom: number;
  /** 0-500 GB of extra system disk, fixed at creation time. */
  expandSystemDiskGb?: number;
  /** Region preference list; AutoDL picks the first with capacity. */
  regions?: string[];
  name?: string;
  /** Shell command run after boot. Also how the TTL guard arms itself. */
  startCommand?: string;
}

const MAX_GPU_NUM = 4;
const MAX_DISK_GB = 500;

function validateCreateInput(input: CreateInstanceInput): void {
  if (!Number.isInteger(input.gpuNum) || input.gpuNum < 1 || input.gpuNum > MAX_GPU_NUM) {
    throw new UsageError(`GPU 数量必须是 1-${MAX_GPU_NUM} 之间的整数，收到 ${input.gpuNum}`);
  }
  const disk = input.expandSystemDiskGb ?? 0;
  if (!Number.isInteger(disk) || disk < 0 || disk > MAX_DISK_GB) {
    throw new UsageError(`系统盘扩容必须是 0-${MAX_DISK_GB} GB 之间的整数，收到 ${disk}`);
  }
  if (!input.imageUuid) {
    throw new UsageError("必须指定镜像（--image）");
  }
}

/** Create a pay-as-you-go Pro instance. Returns the new instance uuid. */
export async function createInstance(
  client: AutoDLClient,
  input: CreateInstanceInput,
): Promise<string> {
  validateCreateInput(input);
  const payload: Record<string, unknown> = {
    req_gpu_amount: input.gpuNum,
    gpu_spec_uuid: input.gpuSpec,
    image_uuid: input.imageUuid,
    cuda_v_from: input.cudaFrom,
    expand_system_disk_by_gb: input.expandSystemDiskGb ?? 0,
  };
  if (input.regions?.length) payload.data_center_list = input.regions;
  if (input.name) payload.instance_name = input.name;
  if (input.startCommand) payload.start_command = input.startCommand;

  // Creation is not idempotent: a retry after an ambiguous failure could rent a
  // second GPU. Never retry it.
  const uuid = await client.post<string>("/api/v1/dev/instance/pro/create", payload, {
    maxRetries: 0,
  });
  return uuid;
}

export interface ListInstancesOptions {
  pageIndex?: number;
  pageSize?: number;
}

export async function listInstancesPage(
  client: AutoDLClient,
  options: ListInstancesOptions = {},
): Promise<{ instances: Instance[]; pagination: Pagination }> {
  const data = await client.post<{ list?: unknown[] } & Record<string, unknown>>(
    "/api/v1/dev/instance/pro/list",
    { page_index: options.pageIndex ?? 1, page_size: options.pageSize ?? 50 },
  );
  const list = Array.isArray(data?.list) ? data.list : [];
  return {
    instances: list.map(normalizeInstance),
    pagination: normalizePagination(data),
  };
}

/** Walk every page so callers never have to think about pagination. */
export async function listAllInstances(client: AutoDLClient): Promise<Instance[]> {
  const pageSize = 100;
  const first = await listInstancesPage(client, { pageIndex: 1, pageSize });
  const all = [...first.instances];
  for (let page = 2; page <= first.pagination.maxPage; page++) {
    const next = await listInstancesPage(client, { pageIndex: page, pageSize });
    all.push(...next.instances);
    if (next.instances.length === 0) break;
  }
  return all;
}

export async function getInstanceStatus(client: AutoDLClient, uuid: string): Promise<string> {
  return client.get<string>("/api/v1/dev/instance/pro/status", { instance_uuid: uuid });
}

export async function getInstanceSnapshot(
  client: AutoDLClient,
  uuid: string,
): Promise<InstanceSnapshot> {
  const data = await client.get<unknown>("/api/v1/dev/instance/pro/snapshot", {
    instance_uuid: uuid,
  });
  return normalizeSnapshot(data);
}

/** Find one instance in the list endpoint (there is no per-instance GET). */
export async function findInstance(client: AutoDLClient, uuid: string): Promise<Instance> {
  const all = await listAllInstances(client);
  const found = all.find((instance) => instance.uuid === uuid);
  if (!found) {
    throw new NotFoundError(`未找到实例 ${uuid}`, {
      hint: "运行 `autodl ls` 查看当前账号下的实例。",
    });
  }
  return found;
}

export interface PowerOnOptions {
  /**
   * `payload` is fixed to "gpu" because nothing else works.
   *
   * Probed live 2026-08-24 on a shut-down instance: "cpu", "no_gpu", "nogpu",
   * "cpu_only", "cpu-only" and "none" every one returned `不支持的启动模式`, and an
   * empty string was accepted but came back with `start_mode: "gpu"`. AutoDL's ¥0.1/hr
   * 无卡模式 is console-only, so there is no option to expose here.
   */
  startCommand?: string;
}

export async function powerOnInstance(
  client: AutoDLClient,
  uuid: string,
  options: PowerOnOptions = {},
): Promise<void> {
  const payload: Record<string, unknown> = { instance_uuid: uuid, payload: "gpu" };
  if (options.startCommand) payload.start_command = options.startCommand;
  await client.post("/api/v1/dev/instance/pro/power_on", payload, { maxRetries: 0 });
}

export async function powerOffInstance(client: AutoDLClient, uuid: string): Promise<void> {
  await client.post("/api/v1/dev/instance/pro/power_off", { instance_uuid: uuid });
}

/** AutoDL requires the instance to be shut down first; this is irreversible. */
export async function releaseInstance(client: AutoDLClient, uuid: string): Promise<void> {
  await client.post("/api/v1/dev/instance/pro/release", { instance_uuid: uuid }, { maxRetries: 0 });
}
