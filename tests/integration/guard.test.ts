import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutoDLClient } from "../../src/core/client.js";
import { BudgetError } from "../../src/core/errors.js";
import { assertBudget } from "../../src/guard/budget.js";
import { mockFetch } from "../fixtures/mock-fetch.js";

/**
 * The guards are the reason this tool is safe to hand to an agent, so they are tested
 * against observable behaviour (was power_off actually called?) rather than internals.
 */

const BALANCE = "/api/v1/dev/wallet/balance";
const STATUS = "/api/v1/dev/instance/pro/status";
const POWER_OFF = "/api/v1/dev/instance/pro/power_off";

let configDir: string;

// The ledger lives in the config dir; point it at a temp dir per test so runs are
// isolated and never touch the developer's real state file.
beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "autodl-guard-"));
  process.env.AUTODL_CONFIG_DIR = configDir;
});

afterEach(async () => {
  delete process.env.AUTODL_CONFIG_DIR;
  delete process.env.AUTODL_MIN_BALANCE;
  await rm(configDir, { recursive: true, force: true });
});

function client(fetchImpl: typeof fetch) {
  return new AutoDLClient({ token: "t", fetchImpl, retryBaseDelayMs: 1 });
}

const balanceOf = (yuan: number, voucher = 0) => ({
  code: "Success",
  msg: "",
  data: { assets: yuan * 1000, accumulate: 0, voucher_balance: voucher * 1000 },
});

describe("the balance gate", () => {
  it("allows a create when the wallet is healthy", async () => {
    const fetchMock = mockFetch([{ path: BALANCE, response: balanceOf(50) }]);
    await expect(assertBudget(client(fetchMock.impl))).resolves.toBe(50);
  });

  it("blocks a create below the default ¥5 threshold", async () => {
    // AutoDL keeps low-balance instances alive to protect data, so the failure mode
    // is a stuck unusable box rather than a clean error. Stop before renting.
    const fetchMock = mockFetch([{ path: BALANCE, response: balanceOf(1) }]);
    await expect(assertBudget(client(fetchMock.impl))).rejects.toThrow(BudgetError);
  });

  it("counts vouchers as spendable", async () => {
    const fetchMock = mockFetch([{ path: BALANCE, response: balanceOf(1, 20) }]);
    await expect(assertBudget(client(fetchMock.impl))).resolves.toBe(21);
  });

  it("honours an explicit threshold over the default", async () => {
    const fetchMock = mockFetch([{ path: BALANCE, response: balanceOf(50) }]);
    await expect(assertBudget(client(fetchMock.impl), 100)).rejects.toThrow(BudgetError);
  });

  it("can be disabled entirely with a zero threshold", async () => {
    // Nothing should be fetched at all when the gate is off.
    const fetchMock = mockFetch([{ path: BALANCE, response: balanceOf(0) }]);
    await expect(assertBudget(client(fetchMock.impl), 0)).resolves.toBe(Number.POSITIVE_INFINITY);
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("reads a threshold from AUTODL_MIN_BALANCE", async () => {
    process.env.AUTODL_MIN_BALANCE = "30";
    const fetchMock = mockFetch([{ path: BALANCE, response: balanceOf(20) }]);
    await expect(assertBudget(client(fetchMock.impl))).rejects.toThrow(BudgetError);
  });

  it("reports both numbers so the user knows how far short they are", async () => {
    const fetchMock = mockFetch([{ path: BALANCE, response: balanceOf(2) }]);
    await expect(assertBudget(client(fetchMock.impl))).rejects.toThrow(/¥2\.00.*¥5\.00/);
  });
});

describe("the TTL sweep", () => {
  // Imported lazily: these modules read the config dir at call time, and the env var
  // must be set by beforeEach first.
  async function guard() {
    return import("../../src/guard/ttl.js");
  }
  async function state() {
    return import("../../src/config/state.js");
  }

  it("powers off a tracked instance past its TTL", async () => {
    const { recordTTL, sweepExpired } = await guard();
    recordTTL({ uuid: "pro-expired", ttlSeconds: 1, inInstanceTimer: false });
    // Rewind the clock by rewriting the entry as already expired.
    const { trackInstance } = await state();
    trackInstance({
      uuid: "pro-expired",
      ttlSeconds: 1,
      expiresAt: Date.now() - 60_000,
      createdAt: Date.now() - 120_000,
      inInstanceTimer: false,
    });

    const fetchMock = mockFetch([
      { path: STATUS, response: { code: "Success", msg: "", data: "running" } },
      { path: POWER_OFF, response: { code: "Success", msg: "", data: null } },
    ]);

    const result = await sweepExpired(client(fetchMock.impl));
    expect(result.stopped).toEqual(["pro-expired"]);
    expect(fetchMock.calls.some((call) => call.url.includes("power_off"))).toBe(true);

    // And it stops tracking, so the next sweep is a no-op.
    const { listTracked } = await state();
    expect(listTracked()).toHaveLength(0);
  });

  it("leaves an instance that is still within its TTL alone", async () => {
    const { recordTTL, sweepExpired } = await guard();
    recordTTL({ uuid: "pro-fresh", ttlSeconds: 3600, inInstanceTimer: true });

    const fetchMock = mockFetch([
      { path: STATUS, response: { code: "Success", msg: "", data: "running" } },
    ]);
    const result = await sweepExpired(client(fetchMock.impl));

    expect(result.stopped).toEqual([]);
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("does not call power_off on an instance that is already shut down", async () => {
    const { trackInstance } = await state();
    const { sweepExpired } = await guard();
    trackInstance({
      uuid: "pro-already-off",
      ttlSeconds: 1,
      expiresAt: Date.now() - 1000,
      createdAt: Date.now() - 2000,
      inInstanceTimer: true,
    });

    const fetchMock = mockFetch([
      { path: STATUS, response: { code: "Success", msg: "", data: "shutdown" } },
    ]);
    const result = await sweepExpired(client(fetchMock.impl));

    expect(result.alreadyStopped).toEqual(["pro-already-off"]);
    expect(fetchMock.calls.some((call) => call.url.includes("power_off"))).toBe(false);
  });

  it("stops tracking an instance that no longer exists", async () => {
    // A released instance would otherwise be retried on every single command forever.
    const { trackInstance, listTracked } = await state();
    const { sweepExpired } = await guard();
    trackInstance({
      uuid: "pro-released",
      ttlSeconds: 1,
      expiresAt: Date.now() - 1000,
      createdAt: Date.now() - 2000,
      inInstanceTimer: true,
    });

    const fetchMock = mockFetch([{ path: STATUS, response: { code: "Fail", msg: "实例不存在" } }]);
    const result = await sweepExpired(client(fetchMock.impl));

    expect(result.failed).toHaveLength(1);
    expect(listTracked()).toHaveLength(0);
  });

  it("is a no-op when nothing is tracked", async () => {
    const { sweepExpired } = await guard();
    const fetchMock = mockFetch([]);
    await expect(sweepExpired(client(fetchMock.impl))).resolves.toEqual({
      stopped: [],
      alreadyStopped: [],
      failed: [],
    });
  });
});
