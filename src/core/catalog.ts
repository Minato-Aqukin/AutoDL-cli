import { UsageError } from "./errors.js";

/**
 * Static reference data.
 *
 * AutoDL's open API exposes no catalogue or stock endpoint for Pro instances, so the
 * GPU specs, region codes and public base images have to be baked in. They can drift
 * when the platform changes — `autodl gpus` / `regions` / `images --base` print this
 * table, and the README asks users to open an issue when something is stale.
 *
 * Sources: https://www.autodl.com/docs/instance_pro_api/ and /docs/esd_api_doc/
 * Last verified: 2026-08.
 */

export interface GpuSpec {
  /** Value for `gpu_spec_uuid` in the create payload. */
  id: string;
  /** Name as shown in the AutoDL console. */
  displayName: string;
  /** AutoDL's own tiering: 通用型 vs 性能型. */
  tier: "general" | "performance";
  vramGb: number;
  /** Convenience aliases so `--gpu 4090` resolves without the exact spec id. */
  aliases: string[];
  /**
   * The name this GPU goes by in the stock endpoint, which uses a different naming
   * scheme from `gpu_spec_uuid`. Verified against live data: westDC3 returns both
   * `vGPU-48GB` and `vGPU-48GB-350W`, matching the `v-48g` / `v-48g-350w` split
   * exactly, which is what makes this mapping safe to hardcode.
   */
  stockName: string;
}

export const GPU_SPECS: readonly GpuSpec[] = [
  {
    id: "h800",
    displayName: "H800-80G",
    tier: "general",
    vramGb: 80,
    aliases: ["h800", "h800-80g"],
    stockName: "H800",
  },
  {
    id: "v-48g",
    displayName: "4090-48G",
    tier: "general",
    vramGb: 48,
    aliases: ["4090", "4090-48g", "v-48g"],
    stockName: "vGPU-48GB",
  },
  {
    id: "4090D",
    displayName: "4090D",
    tier: "general",
    vramGb: 24,
    aliases: ["4090d"],
    stockName: "RTX 4090D",
  },
  {
    id: "v-48g-350w",
    displayName: "3090-48G",
    tier: "general",
    vramGb: 48,
    aliases: ["3090", "3090-48g", "v-48g-350w"],
    stockName: "vGPU-48GB-350W",
  },
  {
    id: "pro6000-p",
    displayName: "PRO6000-96G",
    tier: "performance",
    vramGb: 96,
    aliases: ["pro6000", "rtx-pro-6000", "pro6000-96g"],
    stockName: "RTX PRO 6000",
  },
  {
    id: "v-32g-p",
    displayName: "4080(S)-32G",
    tier: "performance",
    vramGb: 32,
    aliases: ["4080", "4080s", "4080-32g"],
    stockName: "vGPU-32GB",
  },
  {
    id: "5090-p",
    displayName: "5090-32G",
    tier: "performance",
    vramGb: 32,
    aliases: ["5090", "5090-32g"],
    stockName: "RTX 5090",
  },
] as const;

/**
 * A region in the `data_center_list` / `gpu_stock` namespace.
 *
 * AutoDL uses a *different* namespace in instance responses — an instance in 北京B区
 * reports `region_sign: "bj-B2"`, not `beijingDC2`. Never feed an instance's reported
 * region back into these APIs; see `assertStockRegion`.
 *
 * Names verified against the official elastic-deployment API docs, 2026-08.
 */
export interface Region {
  /** Value for `data_center_list` entries. */
  id: string;
  displayName: string;
  aliases: string[];
  /**
   * Whether Pro instance creation accepts this region in `data_center_list`.
   *
   * Only two do. Every other region is elastic-deployment only and makes
   * `instance/pro/create` fail with `RequestParameterIsWrong`. Verified empirically
   * against the live API on 2026-08-23 by probing all eleven.
   */
  proCreate: boolean;
}

export const REGIONS: readonly Region[] = [
  {
    id: "westDC2",
    displayName: "西北企业区",
    aliases: ["west2", "西北企业区", "西北企业"],
    proCreate: false,
  },
  {
    id: "westDC3",
    displayName: "西北B区",
    aliases: ["west3", "西北b区", "西北b"],
    proCreate: true,
  },
  {
    id: "beijingDC1",
    displayName: "北京A区",
    aliases: ["bj1", "北京a区", "北京a"],
    proCreate: false,
  },
  {
    id: "beijingDC2",
    displayName: "北京B区",
    aliases: ["bj2", "北京b区", "北京b"],
    proCreate: true,
  },
  {
    id: "beijingDC3",
    displayName: "V100专区",
    aliases: ["bj3", "v100", "v100专区"],
    proCreate: false,
  },
  {
    id: "beijingDC4",
    displayName: "L20专区",
    aliases: ["bj4", "l20", "l20专区"],
    proCreate: false,
  },
  {
    id: "neimengDC1",
    displayName: "内蒙A区",
    aliases: ["nm1", "内蒙a区", "内蒙a"],
    proCreate: false,
  },
  {
    id: "neimengDC3",
    displayName: "内蒙B区",
    aliases: ["nm3", "内蒙b区", "内蒙b"],
    proCreate: false,
  },
  { id: "foshanDC1", displayName: "佛山区", aliases: ["fs1", "佛山"], proCreate: false },
  {
    id: "chongqingDC1",
    displayName: "重庆A区",
    aliases: ["cq1", "重庆a区", "重庆"],
    proCreate: false,
  },
  {
    id: "yangzhouDC1",
    displayName: "3090专区",
    aliases: ["yz1", "3090专区", "扬州"],
    proCreate: false,
  },
] as const;

export interface BaseImage {
  uuid: string;
  framework: string;
  /** Full image tag as AutoDL names it. */
  tag: string;
  cuda: string;
  python: string;
}

export const BASE_IMAGES: readonly BaseImage[] = [
  {
    uuid: "base-image-l2t43iu6uk",
    framework: "PyTorch",
    tag: "cuda11.8-cudnn8-devel-ubuntu20.04-py38-torch2.0.0",
    cuda: "11.8",
    python: "3.8",
  },
  {
    uuid: "base-image-l374uiucui",
    framework: "PyTorch",
    tag: "cuda11.3-cudnn8-devel-ubuntu20.04-py38-torch1.11.0",
    cuda: "11.3",
    python: "3.8",
  },
  {
    uuid: "base-image-u9r24vthlk",
    framework: "PyTorch",
    tag: "cuda11.3-cudnn8-devel-ubuntu20.04-py38-torch1.10.0",
    cuda: "11.3",
    python: "3.8",
  },
  {
    uuid: "base-image-12be412037",
    framework: "PyTorch",
    tag: "cuda11.1-cudnn8-devel-ubuntu18.04-py38-torch1.9.0",
    cuda: "11.1",
    python: "3.8",
  },
  {
    uuid: "base-image-uxeklgirir",
    framework: "TensorFlow",
    tag: "cuda11.2-cudnn8-devel-ubuntu20.04-py38-tf2.9.0",
    cuda: "11.2",
    python: "3.8",
  },
  {
    uuid: "base-image-0gxqmciyth",
    framework: "TensorFlow",
    tag: "cuda11.2-cudnn8-devel-ubuntu18.04-py38-tf2.5.0",
    cuda: "11.2",
    python: "3.8",
  },
  {
    uuid: "base-image-4bpg0tt88l",
    framework: "TensorFlow",
    tag: "cuda11.4-py38-tf1.15.5",
    cuda: "11.4",
    python: "3.8",
  },
  {
    uuid: "base-image-mbr2n4urrc",
    framework: "Miniconda",
    tag: "cuda11.6-cudnn8-devel-ubuntu20.04-py38",
    cuda: "11.6",
    python: "3.8",
  },
  {
    uuid: "base-image-7bn8iqhkb5",
    framework: "Miniconda",
    tag: "cudagl11.3-cudnn8-devel-ubuntu20.04-py38",
    cuda: "11.3",
    python: "3.8",
  },
  {
    uuid: "base-image-h041hn36yt",
    framework: "Miniconda",
    tag: "cuda11.1-cudnn8-devel-ubuntu18.04-py38",
    cuda: "11.1",
    python: "3.8",
  },
  {
    uuid: "base-image-qkkhitpik5",
    framework: "Miniconda",
    tag: "cuda10.2-cudnn7-devel-ubuntu18.04-py38",
    cuda: "10.2",
    python: "3.8",
  },
  {
    uuid: "base-image-k0vep6kyq8",
    framework: "Miniconda",
    tag: "cuda9.0-cudnn7-devel-ubuntu16.04-py36",
    cuda: "9.0",
    python: "3.6",
  },
  {
    uuid: "base-image-l2843iu23k",
    framework: "TensorRT",
    tag: "cuda11.8-cudnn8-devel-ubuntu20.04-py38-trt8.5.1",
    cuda: "11.8",
    python: "3.8",
  },
] as const;

/** The image `autodl create` picks when the user doesn't name one. */
export const DEFAULT_BASE_IMAGE = "base-image-l2t43iu6uk";

function norm(value: string): string {
  return value.trim().toLowerCase();
}

/** Resolve a user-supplied GPU string to a spec id, accepting display names and aliases. */
export function resolveGpuSpec(input: string): GpuSpec | undefined {
  const needle = norm(input);
  return GPU_SPECS.find(
    (spec) =>
      norm(spec.id) === needle ||
      norm(spec.displayName) === needle ||
      spec.aliases.some((alias) => norm(alias) === needle),
  );
}

export function resolveRegion(input: string): Region | undefined {
  const needle = norm(input);
  return REGIONS.find(
    (region) =>
      norm(region.id) === needle ||
      norm(region.displayName) === needle ||
      region.aliases.some((alias) => norm(alias) === needle),
  );
}

/**
 * Guard the stock endpoint against a region id from the wrong namespace.
 *
 * `gpu_stock` answers an unknown region with `{"code":"Success","data":[]}` — a typo and
 * a genuinely sold-out region are indistinguishable in the response. Without this check
 * `--region bj-B2` would silently report "no stock" forever.
 */
export function assertStockRegion(input: string): Region {
  const region = resolveRegion(input);
  if (!region) {
    throw new UsageError(`未知的地区 "${input}"`, {
      hint: "运行 `autodl regions` 查看有效地区代码。注意实例返回的 region_sign（如 bj-B2）与这里的地区代码（如 beijingDC2）不是同一套命名，不能混用。",
    });
  }
  return region;
}

/** Regions that `instance/pro/create` will actually accept. */
export const PRO_CREATE_REGIONS: readonly Region[] = REGIONS.filter((region) => region.proCreate);

/**
 * Validate a region for Pro instance creation.
 *
 * AutoDL rejects the other nine regions with an opaque "请求参数错误", which gives the
 * user nothing to act on. Fail here instead, naming the two that work.
 */
export function assertProCreateRegion(input: string): Region {
  const region = assertStockRegion(input);
  if (!region.proCreate) {
    throw new UsageError(`地区 "${region.displayName}"（${region.id}）不支持创建 Pro 实例`, {
      hint: `官方开放 API 只能在 ${PRO_CREATE_REGIONS.map((r) => `${r.displayName}(${r.id})`).join(" 或 ")} 创建实例；其余地区仅用于弹性部署。不指定 --region 时由 AutoDL 自行调度，成功率更高。`,
    });
  }
  return region;
}

export function findBaseImage(input: string): BaseImage | undefined {
  const needle = norm(input);
  return BASE_IMAGES.find((image) => norm(image.uuid) === needle || norm(image.tag) === needle);
}

/** `11.8` / `118` / `11` -> the integer form AutoDL's `cuda_v_from` expects. */
export function parseCudaVersion(input: string | number): number {
  if (typeof input === "number") return input >= 100 ? input : Math.round(input * 10);
  const trimmed = input.trim();
  if (/^\d{3}$/.test(trimmed)) return Number(trimmed);
  const asFloat = Number.parseFloat(trimmed);
  if (Number.isNaN(asFloat)) return 0;
  const [major = "0", minor = "0"] = trimmed.split(".");
  return Number(major) * 10 + Number(minor.slice(0, 1) || "0");
}

/** Inverse of parseCudaVersion, for display: `118` -> `11.8`. */
export function formatCudaVersion(value: number): string {
  if (!value) return "-";
  return `${Math.floor(value / 10)}.${value % 10}`;
}
