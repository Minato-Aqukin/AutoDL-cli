import { Buffer } from "node:buffer";
import { render } from "ink-testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Instance } from "../../src/core/schemas.js";
import { normalizeSnapshot } from "../../src/core/schemas.js";
import { snapshotResponse } from "../fixtures/responses.js";

/**
 * The snapshot cache has to expire with the power cycle that produced it.
 *
 * AutoDL rotates the SSH host, port and root password every time an instance is powered
 * on, so a snapshot describes one boot and no more. Cached across a stop/start it hands
 * the user a command that connects to nothing and a password that opens nothing — and
 * `c` copies that straight to the clipboard, which is the whole point of the key.
 */

const BOOT_ONE = "2026-09-05T10:00:00Z";
const BOOT_TWO = "2026-09-05T12:00:00Z";

function instance(startedAt: string): Instance {
  return {
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
    createdAt: "2026-09-05T09:00:00Z",
    startedAt,
    stoppedAt: null,
    expiredAt: null,
    timedShutdownAt: null,
  };
}

const state = vi.hoisted(() => ({
  startedAt: "2026-09-05T10:00:00Z",
  port: 34222,
  password: "first-password",
  cpu: 12,
}));

vi.mock("../../src/core/endpoints/instance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/endpoints/instance.js")>();
  return {
    ...actual,
    listAllInstances: vi.fn(async () => [instance(state.startedAt)]),
    getInstanceSnapshot: vi.fn(async () =>
      normalizeSnapshot({
        ...snapshotResponse.data,
        ssh_port: state.port,
        root_password: state.password,
        ssh_command: `ssh -p ${state.port} root@connect.xxx.autodl.com`,
        usage_info: { ...snapshotResponse.data.usage_info, cpu_usage_percent: state.cpu },
      }),
    ),
    getInstanceStatus: vi.fn(async () => "running"),
    powerOnInstance: vi.fn(async () => undefined),
    powerOffInstance: vi.fn(async () => undefined),
    releaseInstance: vi.fn(async () => undefined),
  };
});

vi.mock("../../src/core/endpoints/account.js", () => ({
  getBalance: vi.fn(async () => ({ balanceYuan: 100, accumulatedYuan: 20, voucherYuan: 0 })),
}));

const copied = vi.hoisted(() => vi.fn());
vi.mock("../../src/tui/clipboard.js", () => ({
  copyToClipboard: async (text: string) => {
    copied(text);
    return { ok: true, method: "native" as const };
  },
}));

const { App } = await import("../../src/tui/app.js");

const plain = (s: string | undefined) =>
  (s ?? "").replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TOKEN = [
  "header",
  Buffer.from(JSON.stringify({ uid: 785976 })).toString("base64url"),
  "sig",
].join(".");

const mount = () =>
  render(<App client={{} as never} token={TOKEN} tokenSource="config" onLogout={vi.fn()} />);

beforeEach(() => {
  state.startedAt = BOOT_ONE;
  state.port = 34222;
  state.password = "first-password";
  state.cpu = 12;
  copied.mockReset();
});

describe("the resource panel is a live view", () => {
  it("re-samples usage on a refresh instead of holding the first reading", async () => {
    // The panel used to be fed a snapshot fetched once and cached forever, which meant a
    // CPU bar frozen at whatever the instance happened to be doing when it was opened.
    const { stdin, lastFrame } = mount();
    await wait(80);
    expect(plain(lastFrame())).toContain("12.0%");

    state.cpu = 87;
    stdin.write("r");
    await wait(120);
    const out = plain(lastFrame());
    expect(out).toContain("87.0%");
    expect(out).not.toContain("12.0%");
  });

  it("accumulates the readings into a history the sparkline can draw", async () => {
    const { stdin, lastFrame } = mount();
    await wait(80);
    state.cpu = 87;
    stdin.write("r");
    await wait(120);

    // Two samples so far: a low one and a high one, in that order.
    expect(plain(lastFrame())).toMatch(/[▁▂][▇█]/);
  });
});

describe("SSH details across a power cycle", () => {
  it("copies the current boot's command", async () => {
    const { stdin } = mount();
    await wait(80);
    stdin.write("c");
    await wait(60);
    expect(copied).toHaveBeenCalledWith("ssh -p 34222 root@connect.xxx.autodl.com");
  });

  it("copies the new port after the instance is power-cycled", async () => {
    const { stdin } = mount();
    await wait(80);
    stdin.write("c");
    await wait(60);
    expect(copied).toHaveBeenCalledWith("ssh -p 34222 root@connect.xxx.autodl.com");

    // Stopped and started again: AutoDL hands out a fresh port and password.
    state.startedAt = BOOT_TWO;
    state.port = 51999;
    state.password = "second-password";
    copied.mockReset();
    stdin.write("r");
    await wait(120);

    stdin.write("c");
    await wait(60);
    expect(copied).toHaveBeenCalledWith("ssh -p 51999 root@connect.xxx.autodl.com");
    expect(copied).not.toHaveBeenCalledWith("ssh -p 34222 root@connect.xxx.autodl.com");
  });

  it("shows the new password on the detail screen, not the one from the last boot", async () => {
    const { stdin, lastFrame } = mount();
    await wait(80);

    state.startedAt = BOOT_TWO;
    state.port = 51999;
    state.password = "second-password";
    stdin.write("r");
    await wait(120);

    // Enter opens the detail screen, p reveals the password.
    stdin.write("\r");
    await wait(40);
    stdin.write("p");
    await wait(40);

    const out = plain(lastFrame());
    expect(out).toContain("second-password");
    expect(out).not.toContain("first-password");
  });
});
