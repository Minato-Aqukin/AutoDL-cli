import { describe, expect, it } from "vitest";
import {
  assertStockRegion,
  BASE_IMAGES,
  findBaseImage,
  formatCudaVersion,
  GPU_SPECS,
  parseCudaVersion,
  REGIONS,
  resolveGpuSpec,
  resolveRegion,
} from "../../src/core/catalog.js";
import { UsageError } from "../../src/core/errors.js";
import { specForStockName } from "../../src/core/stock.js";

describe("resolveGpuSpec", () => {
  it("resolves by spec id", () => {
    expect(resolveGpuSpec("pro6000-p")?.id).toBe("pro6000-p");
  });

  it("resolves by the console display name", () => {
    expect(resolveGpuSpec("4090-48G")?.id).toBe("v-48g");
  });

  it("resolves by short alias, which is what users actually type", () => {
    expect(resolveGpuSpec("4090")?.id).toBe("v-48g");
    expect(resolveGpuSpec("3090")?.id).toBe("v-48g-350w");
    expect(resolveGpuSpec("5090")?.id).toBe("5090-p");
  });

  it("is case-insensitive", () => {
    expect(resolveGpuSpec("H800")?.id).toBe("h800");
    expect(resolveGpuSpec("PRO6000")?.id).toBe("pro6000-p");
  });

  it("returns undefined for specs the open API cannot rent", () => {
    // Standard (non-Pro) instances aren't reachable through the official API.
    expect(resolveGpuSpec("A100")).toBeUndefined();
    expect(resolveGpuSpec("")).toBeUndefined();
  });
});

describe("resolveRegion", () => {
  it("resolves ids, names and aliases", () => {
    expect(resolveRegion("westDC3")?.id).toBe("westDC3");
    expect(resolveRegion("bj2")?.id).toBe("beijingDC2");
    expect(resolveRegion("内蒙B区")?.id).toBe("neimengDC3");
  });
});

describe("CUDA version encoding", () => {
  it("encodes dotted versions the way cuda_v_from expects", () => {
    expect(parseCudaVersion("11.8")).toBe(118);
    expect(parseCudaVersion("12.1")).toBe(121);
    expect(parseCudaVersion("9.0")).toBe(90);
  });

  it("passes through values already in integer form", () => {
    expect(parseCudaVersion("118")).toBe(118);
    expect(parseCudaVersion(121)).toBe(121);
  });

  it("round-trips for display", () => {
    expect(formatCudaVersion(118)).toBe("11.8");
    expect(formatCudaVersion(parseCudaVersion("12.1"))).toBe("12.1");
  });
});

describe("stock name mapping", () => {
  // gpu_stock speaks a different naming scheme from gpu_spec_uuid. Verified against
  // live data: westDC3 returns both vGPU-48GB and vGPU-48GB-350W, which is what makes
  // the v-48g / v-48g-350w split safe to hardcode.
  it("gives every spec a stock name", () => {
    for (const spec of GPU_SPECS) {
      expect(spec.stockName, spec.id).toBeTruthy();
    }
  });

  it("keeps stock names unique, so a lookup can never be ambiguous", () => {
    const names = GPU_SPECS.map((spec) => spec.stockName);
    expect(new Set(names).size).toBe(names.length);
  });

  it("maps each spec to the name observed in live stock data", () => {
    const expected: Record<string, string> = {
      h800: "H800",
      "v-48g": "vGPU-48GB",
      "v-48g-350w": "vGPU-48GB-350W",
      "v-32g-p": "vGPU-32GB",
      "pro6000-p": "RTX PRO 6000",
      "5090-p": "RTX 5090",
      "4090D": "RTX 4090D",
    };
    for (const spec of GPU_SPECS) {
      expect(spec.stockName, spec.id).toBe(expected[spec.id]);
    }
  });

  it("round-trips through specForStockName", () => {
    for (const spec of GPU_SPECS) {
      expect(specForStockName(spec.stockName)?.id).toBe(spec.id);
    }
  });

  it("does not claim physical cards the open API cannot rent", () => {
    // Live stock lists a plain "RTX 4090" and "RTX 3090" alongside the vGPU variants.
    // Only the vGPU partitions are rentable as Pro instances; conflating them would
    // send users to a region holding a card they cannot get.
    expect(specForStockName("RTX 4090")).toBeUndefined();
    expect(specForStockName("RTX 3090")).toBeUndefined();
  });
});

describe("assertStockRegion", () => {
  it("accepts region ids and aliases", () => {
    expect(assertStockRegion("beijingDC2").id).toBe("beijingDC2");
    expect(assertStockRegion("bj2").id).toBe("beijingDC2");
  });

  it("rejects a region_sign from the instance namespace", () => {
    // This is the whole point: gpu_stock answers an unknown region with
    // {"code":"Success","data":[]}, so a typo would silently read as "sold out".
    expect(() => assertStockRegion("bj-B2")).toThrow(UsageError);
    expect(() => assertStockRegion("neimeng-C")).toThrow(UsageError);
  });

  it("explains the two namespaces in the hint", () => {
    try {
      assertStockRegion("bj-B2");
      expect.unreachable();
    } catch (err) {
      expect((err as UsageError).hint).toContain("region_sign");
    }
  });
});

describe("region labels match the official docs", () => {
  it.each([
    ["westDC2", "西北企业区"],
    ["westDC3", "西北B区"],
    ["beijingDC1", "北京A区"],
    ["beijingDC2", "北京B区"],
    ["beijingDC3", "V100专区"],
    ["beijingDC4", "L20专区"],
    ["neimengDC1", "内蒙A区"],
    ["neimengDC3", "内蒙B区"],
    ["yangzhouDC1", "3090专区"],
  ])("%s is %s", (id, name) => {
    expect(REGIONS.find((region) => region.id === id)?.displayName).toBe(name);
  });
});

describe("catalogue integrity", () => {
  it("has unique gpu spec ids", () => {
    const ids = GPU_SPECS.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves every alias back to its own spec", () => {
    for (const spec of GPU_SPECS) {
      for (const alias of spec.aliases) {
        expect(resolveGpuSpec(alias)?.id).toBe(spec.id);
      }
    }
  });

  it("finds every base image by both uuid and tag", () => {
    for (const image of BASE_IMAGES) {
      expect(findBaseImage(image.uuid)?.uuid).toBe(image.uuid);
      expect(findBaseImage(image.tag)?.uuid).toBe(image.uuid);
    }
  });

  it("has unique base image uuids", () => {
    const uuids = BASE_IMAGES.map((image) => image.uuid);
    expect(new Set(uuids).size).toBe(uuids.length);
  });
});
