import { afterEach, describe, expect, it } from "vitest";
import { resolveGpuSpec } from "../../src/core/catalog.js";
import { AutoDLClient } from "../../src/core/client.js";
import { getRegionGpuStock } from "../../src/core/endpoints/machine.js";
import { UsageError } from "../../src/core/errors.js";
import { chooseRegions, findRegionsWithStock } from "../../src/core/stock.js";
import { configureOutput } from "../../src/output/format.js";
import { mockFetch } from "../fixtures/mock-fetch.js";
import { stockResponse } from "../fixtures/responses.js";

const STOCK = "/api/v1/dev/machine/region/gpu_stock";

function client(fetchImpl: typeof fetch) {
  return new AutoDLClient({ token: "t", fetchImpl, retryBaseDelayMs: 1 });
}

const pro6000 = resolveGpuSpec("pro6000-p");
if (!pro6000) throw new Error("catalogue is missing pro6000-p");

afterEach(() => {
  configureOutput({ json: false, color: true, verbose: false });
});

describe("getRegionGpuStock", () => {
  it("flattens the single-key-object-per-GPU response shape", async () => {
    const fetchMock = mockFetch([
      {
        path: STOCK,
        response: stockResponse({
          "RTX PRO 6000": { idle: 285, total: 1588 },
          H800: { idle: 3, total: 96 },
        }),
      },
    ]);
    const entries = await getRegionGpuStock(client(fetchMock.impl), { regionSign: "westDC3" });
    expect(entries).toEqual([
      { gpuName: "RTX PRO 6000", idle: 285, total: 1588, chipCorp: "nvidia", cpuArch: "x86" },
      { gpuName: "H800", idle: 3, total: 96, chipCorp: "nvidia", cpuArch: "x86" },
    ]);
  });

  it("normalises the region alias before sending it", async () => {
    const fetchMock = mockFetch([{ path: STOCK, response: stockResponse({}) }]);
    await getRegionGpuStock(client(fetchMock.impl), { regionSign: "bj2" });
    expect(fetchMock.callAt(0).body).toMatchObject({ region_sign: "beijingDC2" });
  });

  it("converts yuan price bounds to AutoDL's milliyuan", async () => {
    const fetchMock = mockFetch([{ path: STOCK, response: stockResponse({}) }]);
    await getRegionGpuStock(client(fetchMock.impl), {
      regionSign: "westDC3",
      priceFromYuan: 1,
      priceToYuan: 9,
    });
    expect(fetchMock.callAt(0).body).toMatchObject({ price_from: 1000, price_to: 9000 });
  });

  it("rejects a cross-namespace region before making any request", async () => {
    // Otherwise the empty success would be misread as "sold out".
    const fetchMock = mockFetch([{ path: STOCK, response: stockResponse({}) }]);
    await expect(
      getRegionGpuStock(client(fetchMock.impl), { regionSign: "bj-B2" }),
    ).rejects.toThrow(UsageError);
    expect(fetchMock.calls).toHaveLength(0);
  });
});

describe("findRegionsWithStock", () => {
  it("ranks regions by idle count, highest first", async () => {
    const byRegion: Record<string, number> = {
      westDC3: 285,
      beijingDC2: 36,
      chongqingDC1: 33,
    };
    const fetchMock = mockFetch([
      {
        path: STOCK,
        response: (call) => {
          const region = (call.body as { region_sign: string }).region_sign;
          const idle = byRegion[region];
          return idle === undefined
            ? stockResponse({})
            : stockResponse({ "RTX PRO 6000": { idle, total: 1000 } });
        },
      },
    ]);

    const { ranked } = await findRegionsWithStock(client(fetchMock.impl), pro6000);
    expect(ranked.map((r) => r.regionId)).toEqual(["westDC3", "beijingDC2", "chongqingDC1"]);
    expect(ranked[0]?.idle).toBe(285);
  });

  it("matches the stock name exactly, never by prefix", async () => {
    // vGPU-48GB and vGPU-48GB-350W are different cards; a prefix match would send a
    // user after the wrong one.
    const v48 = resolveGpuSpec("v-48g");
    if (!v48) throw new Error("missing v-48g");
    const fetchMock = mockFetch([
      {
        path: STOCK,
        response: stockResponse({ "vGPU-48GB-350W": { idle: 11, total: 152 } }),
      },
    ]);
    const { ranked } = await findRegionsWithStock(client(fetchMock.impl), v48, {
      regions: ["westDC3"],
    });
    expect(ranked).toEqual([]);
  });

  it("survives a single region failing", async () => {
    const fetchMock = mockFetch([
      {
        path: STOCK,
        response: (call) =>
          (call.body as { region_sign: string }).region_sign === "beijingDC2"
            ? { code: "Fail", msg: "boom" }
            : stockResponse({ "RTX PRO 6000": { idle: 5, total: 10 } }),
      },
    ]);
    const { ranked, failures } = await findRegionsWithStock(client(fetchMock.impl), pro6000, {
      regions: ["westDC3", "beijingDC2"],
    });
    expect(ranked.map((r) => r.regionId)).toEqual(["westDC3"]);
    expect(failures).toHaveLength(1);
  });
});

describe("chooseRegions", () => {
  it("sends no region list at all when the user did not ask for one", async () => {
    // Measured 2026-08-23: naming westDC3 failed with "暂无库存" while the same request
    // with no region succeeded in beijingDC2. Narrowing can only lower the hit rate,
    // so an unconstrained create stays unconstrained — and skips the lookup entirely.
    const fetchMock = mockFetch([{ path: STOCK, response: stockResponse({}) }]);
    const choice = await chooseRegions(client(fetchMock.impl), pro6000);
    expect(choice.regions).toEqual([]);
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("rejects a region Pro creation cannot use", async () => {
    // AutoDL answers these with an opaque "请求参数错误"; fail with something actionable.
    const fetchMock = mockFetch([{ path: STOCK, response: stockResponse({}) }]);
    await expect(chooseRegions(client(fetchMock.impl), pro6000, ["chongqingDC1"])).rejects.toThrow(
      UsageError,
    );
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("names the two usable regions in the rejection hint", async () => {
    const fetchMock = mockFetch([{ path: STOCK, response: stockResponse({}) }]);
    try {
      await chooseRegions(client(fetchMock.impl), pro6000, ["foshanDC1"]);
      expect.unreachable();
    } catch (err) {
      expect((err as UsageError).hint).toContain("westDC3");
      expect((err as UsageError).hint).toContain("beijingDC2");
    }
  });

  it("orders the user's own regions by stock without dropping any", async () => {
    const idleByRegion: Record<string, number> = { westDC3: 0, beijingDC2: 40 };
    const fetchMock = mockFetch([
      {
        path: STOCK,
        response: (call) => {
          const region = (call.body as { region_sign: string }).region_sign;
          return stockResponse({ "RTX PRO 6000": { idle: idleByRegion[region] ?? 0, total: 500 } });
        },
      },
    ]);
    const choice = await chooseRegions(client(fetchMock.impl), pro6000, ["westDC3", "beijingDC2"]);
    // Best first, but the zero-stock region is still offered as a fallback.
    expect(choice.regions).toEqual(["beijingDC2", "westDC3"]);
  });

  it("still proceeds when the user's regions all report zero", async () => {
    const fetchMock = mockFetch([
      { path: STOCK, response: stockResponse({ "RTX PRO 6000": { idle: 0, total: 500 } }) },
    ]);
    const choice = await chooseRegions(client(fetchMock.impl), pro6000, ["westDC3"]);
    expect(choice.allBusy).toBe(true);
    expect(choice.regions).toEqual(["westDC3"]);
  });
});
