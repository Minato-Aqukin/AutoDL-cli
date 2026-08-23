import { describe, expect, it } from "vitest";
import {
  BASE_IMAGES,
  findBaseImage,
  formatCudaVersion,
  GPU_SPECS,
  parseCudaVersion,
  resolveGpuSpec,
  resolveRegion,
} from "../../src/core/catalog.js";

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
    expect(resolveRegion("内蒙C区")?.id).toBe("neimengDC3");
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
