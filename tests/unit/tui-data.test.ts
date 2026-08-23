import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Instance, InstanceSnapshot } from "../../src/core/schemas.js";
import { normalizeSnapshot } from "../../src/core/schemas.js";
import { buildRow, isLive } from "../../src/tui/data.js";
import { snapshotResponse } from "../fixtures/responses.js";

/**
 * The dashboard's derived columns.
 *
 * The rule that matters most: a cost is only ever shown when the rate is genuinely
 * known. AutoDL exposes a rate solely through a running instance's snapshot, so a
 * plausible-looking number for anything else would be fabricated.
 */

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "autodl-tui-"));
  process.env.AUTODL_CONFIG_DIR = configDir;
});

afterEach(async () => {
  delete process.env.AUTODL_CONFIG_DIR;
  await rm(configDir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-08-24T12:00:00Z");

function instance(overrides: Partial<Instance> = {}): Instance {
  return {
    uuid: "pro-1",
    name: "demo",
    status: "running",
    subStatus: null,
    machineId: null,
    regionSign: "bj-B2",
    regionName: "北京B区",
    chargeType: "payg",
    startMode: "gpu",
    gpuSpec: "4090D",
    gpuNum: 1,
    createdAt: "2026-08-24T11:00:00Z",
    startedAt: new Date(NOW - 3600_000).toISOString(),
    stoppedAt: null,
    expiredAt: null,
    timedShutdownAt: null,
    ...overrides,
  };
}

const snapshot = (): InstanceSnapshot => normalizeSnapshot(snapshotResponse.data);

describe("buildRow", () => {
  it("computes uptime from startedAt for a running instance", () => {
    const row = buildRow(instance(), undefined, NOW);
    expect(row.uptimeSeconds).toBe(3600);
  });

  it("reports no uptime for a stopped instance", () => {
    const row = buildRow(instance({ status: "shutdown" }), undefined, NOW);
    expect(row.uptimeSeconds).toBeNull();
  });

  it("estimates cost from the snapshot rate", () => {
    // snapshotResponse carries payg_price 1970 milliyuan = ¥1.97/hr, one hour of uptime.
    const row = buildRow(instance(), snapshot(), NOW);
    expect(row.priceYuanPerHour).toBe(1.97);
    expect(row.estimatedCostYuan).toBe(1.97);
  });

  it("leaves cost null while the rate is still unknown", () => {
    // Rendered as "…", never as ¥0.00 — which would read as "this is free".
    const row = buildRow(instance(), undefined, NOW);
    expect(row.estimatedCostYuan).toBeNull();
  });

  it("leaves cost null for a stopped instance even if a stale snapshot exists", () => {
    // AutoDL does not expose a rate for a stopped instance; anything shown would be
    // a leftover from when it was running.
    const row = buildRow(instance({ status: "shutdown" }), snapshot(), NOW);
    expect(row.estimatedCostYuan).toBeNull();
  });

  it("treats a zero rate as unknown rather than free", () => {
    const zeroRate = { ...snapshot(), priceYuanPerHour: 0 };
    const row = buildRow(instance(), zeroRate, NOW);
    expect(row.priceYuanPerHour).toBeNull();
    expect(row.estimatedCostYuan).toBeNull();
  });

  it("has no TTL when the instance is not in the local ledger", async () => {
    const row = buildRow(instance(), undefined, NOW);
    expect(row.ttlRemainingMs).toBeNull();
  });

  it("counts down a tracked TTL and goes negative once overdue", async () => {
    const { trackInstance } = await import("../../src/config/state.js");
    trackInstance({
      uuid: "pro-1",
      ttlSeconds: 7200,
      expiresAt: NOW + 600_000,
      createdAt: NOW,
      inInstanceTimer: true,
    });
    expect(buildRow(instance(), undefined, NOW).ttlRemainingMs).toBe(600_000);
    // Past due is what the dashboard paints red — money leaking right now.
    expect(buildRow(instance(), undefined, NOW + 900_000).ttlRemainingMs).toBeLessThan(0);
  });
});

describe("isLive", () => {
  it.each(["running", "starting"])("treats %s as billing", (status) => {
    expect(isLive(status)).toBe(true);
  });

  it.each(["shutdown", "shutting_down", "creating", "released"])("treats %s as idle", (status) => {
    expect(isLive(status)).toBe(false);
  });
});
