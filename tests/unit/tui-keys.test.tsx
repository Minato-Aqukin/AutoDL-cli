import { Buffer } from "node:buffer";
import { render } from "ink-testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardRow } from "../../src/tui/data.js";

/**
 * Key bindings for the destructive action.
 *
 * Release wipes an instance permanently. It used to sit on a bare capital `D`, one
 * slipped shift away from a key that does nothing — now it needs ctrl, and neither a
 * plain `d` nor a plain `D` may do anything at all.
 */

const row: DashboardRow = {
  instance: {
    uuid: "pro-abc",
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
    createdAt: null,
    startedAt: null,
    stoppedAt: null,
    expiredAt: null,
    timedShutdownAt: null,
  },
  uptimeSeconds: 60,
  priceYuanPerHour: 1.97,
  estimatedCostYuan: 0.03,
  ttlRemainingMs: 600_000,
  ttlSeconds: 7200,
};

const destroy = vi.hoisted(() => vi.fn());

vi.mock("../../src/tui/data.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tui/data.js")>();
  return {
    ...actual,
    useInstances: () => ({
      rows: [row],
      loading: false,
      error: null,
      authError: null,
      lastUpdated: Date.now(),
      refresh: vi.fn(),
      snapshotFor: () => undefined,
      loadSnapshot: vi.fn(),
    }),
    destroyInstance: destroy,
    stopInstance: vi.fn(),
    startInstance: vi.fn(),
  };
});

const { App } = await import("../../src/tui/app.js");

const plain = (s: string | undefined) =>
  (s ?? "").replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
const CTRL_D = String.fromCharCode(4);
const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

const client = {} as never;
// A syntactically valid JWT so the header can decode an account id from it.
const TOKEN = [
  "header",
  Buffer.from(JSON.stringify({ uid: 785976 })).toString("base64url"),
  "sig",
].join(".");

beforeEach(() => {
  destroy.mockReset();
});

const mount = () =>
  render(<App client={client} token={TOKEN} tokenSource="config" onLogout={vi.fn()} />);

describe("release binding", () => {
  it("opens the confirmation on ctrl+d", async () => {
    const { stdin, lastFrame } = mount();
    await flush();
    stdin.write(CTRL_D);
    await flush();
    expect(plain(lastFrame())).toContain("释放实例");
  });

  it("does nothing on a plain capital D", async () => {
    // The old binding. A shift-slip must not put a wipe-everything prompt on screen.
    const { stdin, lastFrame } = mount();
    await flush();
    stdin.write("D");
    await flush();
    expect(plain(lastFrame())).not.toContain("释放实例");
  });

  it("does nothing on a plain lowercase d", async () => {
    const { stdin, lastFrame } = mount();
    await flush();
    stdin.write("d");
    await flush();
    expect(plain(lastFrame())).not.toContain("释放实例");
  });

  it("still requires a confirmation before releasing anything", async () => {
    const { stdin } = mount();
    await flush();
    stdin.write(CTRL_D);
    await flush();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("advertises the binding with a lowercase letter, so it does not read as shifted", async () => {
    const { lastFrame } = mount();
    await flush();
    const out = plain(lastFrame());
    expect(out).toContain("ctrl+d 释放");
    expect(out).not.toContain("Ctrl");
    expect(out).not.toContain("· D 释放");
  });
});
