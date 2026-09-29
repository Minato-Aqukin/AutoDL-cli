import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "../../src/ssh/file-types.js";
import type { DashboardRow } from "../../src/tui/data.js";

/**
 * The files view owns a session per open, and the dashboard owns the keys to open it.
 *
 * A fresh workspace on every `f` drops any half-connected SFTP session from the previous
 * visit instead of reusing it, and the view never disposes it on unmount: the workspace
 * outlives its mounts, and App releases it on exit. A corrupt transfer-queue directory
 * flashes on `f` instead of faulting the unobserved open promise. After confirming
 * power-on for the file view, the remote pane gates on a fresh resolved gate (not the
 * stale rejection) so the files view is back instead of the power modal.
 */

const plain = (s: string | undefined) =>
  (s ?? "").replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
const flush = () => new Promise((resolve) => setTimeout(resolve, 40));
const ENTER = "\r";
const ESC = String.fromCharCode(27);

const TOKEN = [
  "header",
  Buffer.from(JSON.stringify({ uid: 785976 })).toString("base64url"),
  "sig",
].join(".");

function makeRow(suffix: string, status = "running"): DashboardRow {
  return {
    instance: {
      uuid: `pro-${suffix}`,
      name: `demo-${suffix}`,
      status,
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
}

/** Queued actions the App test double can observe. */
const appState = vi.hoisted(() => ({
  rows: [] as unknown[],
  statusOf: "running" as string,
  createdWorkspaces: 0,
  disposedWorkspaces: 0,
  queueError: null as Error | null,
}));

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  destroy: vi.fn(),
}));

const credentials = vi.hoisted(() => vi.fn(async () => ({})));

function fakeWorkspace(this: unknown) {
  appState.createdWorkspaces += 1;
  return {
    list: async (): Promise<FileEntry[]> => [],
    mkdir: async (): Promise<void> => undefined,
    rename: async (): Promise<void> => undefined,
    remove: async (): Promise<void> => undefined,
    dispose: () => void appState.disposedWorkspaces++,
  };
}

vi.mock("../../src/tui/data.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tui/data.js")>();
  const { useState } = await import("react");
  return {
    ...actual,
    useInstances: () => {
      const [rows] = useState(appState.rows);
      return {
        rows,
        loading: false,
        error: null,
        authError: null,
        lastUpdated: Date.now(),
        refresh: () => undefined,
        snapshotFor: () => undefined,
        historyFor: () => undefined,
        loadSnapshot: () => undefined,
      };
    },
    startInstance: mocks.start,
    stopInstance: mocks.stop,
    destroyInstance: mocks.destroy,
  };
});

vi.mock("../../src/ssh/transfer-queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/ssh/transfer-queue.js")>();
  return {
    ...actual,
    TransferQueue: class extends actual.TransferQueue {
      constructor(client: never, namespace: never) {
        if (appState.queueError) throw appState.queueError;
        super(client, namespace);
      }
    },
  };
});

vi.mock("../../src/ssh/files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/ssh/files.js")>();
  return { ...actual, FileWorkspace: fakeWorkspace };
});

vi.mock("../../src/core/endpoints/instance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/endpoints/instance.js")>();
  return { ...actual, getInstanceStatus: async () => appState.statusOf };
});

vi.mock("../../src/ssh/credentials.js", () => ({
  getCredentials: credentials,
}));

vi.mock("../../src/core/endpoints/account.js", () => ({
  getBalance: async () => ({ balanceYuan: 12, accumulatedYuan: 30, voucherYuan: 0 }),
}));

const { App } = await import("../../src/tui/app.js");

const mount = () =>
  render(<App client={{} as never} token={TOKEN} tokenSource="config" onLogout={vi.fn()} />);

let configDirectory: string;

beforeEach(() => {
  // The files view opens a real TransferQueue; keep its records out of the
  // developer's own config directory.
  configDirectory = mkdtempSync(join(tmpdir(), "autodl-files-open-"));
  vi.stubEnv("AUTODL_CONFIG_DIR", configDirectory);
  appState.rows = [makeRow("1")];
  appState.statusOf = "running";
  appState.createdWorkspaces = 0;
  appState.disposedWorkspaces = 0;
  appState.queueError = null;
  mocks.start.mockReset();
  mocks.stop.mockReset();
  mocks.destroy.mockReset();
  credentials.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(configDirectory, { recursive: true, force: true });
});

describe("files open owns a fresh workspace", () => {
  it("creates a new workspace on every `f` press on the same instance", async () => {
    const { stdin } = mount();
    await flush();
    stdin.write(ENTER); // detail
    await flush();
    stdin.write("f"); // files
    await flush();
    expect(appState.createdWorkspaces).toBe(1);

    stdin.write(ESC); // Esc back to dashboard
    await flush();
    stdin.write(ENTER); // detail again
    await flush();
    stdin.write("f"); // files again on the same instance
    await flush();

    expect(appState.createdWorkspaces).toBe(2);
    // Leaving the view never disposes: the workspace outlives its mounts.
    expect(appState.disposedWorkspaces).toBe(1);
  });
});

describe("power-on refreshes the files gate", () => {
  it("a stopped instance boots through the modal and remounts files", async () => {
    appState.rows = [makeRow("1", "shutdown")];
    appState.statusOf = "shutdown";
    const { stdin, lastFrame } = mount();
    await flush();
    stdin.write(ENTER);
    await flush();
    stdin.write("f");
    await flush();
    expect(plain(lastFrame())).toContain("启动实例");

    // Ink attaches the modal's key handler in an effect that can run after its first
    // frame is already on screen; a key sent in between is dropped. Resend until the
    // confirmation is taken (getCredentials is its first, synchronous step), so the
    // confirm fires exactly once.
    await vi.waitFor(
      () => {
        if (credentials.mock.calls.length === 0) stdin.write("y");
        expect(credentials).toHaveBeenCalledTimes(1);
      },
      { timeout: 3000, interval: 20 },
    );
    // The gate was refreshed to a resolved promise: the files view is back instead
    // of the power modal. Wait for the view itself rather than a fixed delay — the
    // power-on path is several awaits long and a loaded CI runner is slow.
    await vi.waitFor(
      () => {
        const frame = plain(lastFrame());
        expect(frame).toContain("▸远程");
        expect(frame).not.toContain("启动实例");
      },
      { timeout: 3000, interval: 10 },
    );
  });
});

describe("a corrupt queue directory flashes on `f`", () => {
  it("stays on screen with the reason instead of rejecting", async () => {
    appState.queueError = new Error("传输记录损坏（x.json）：格式非法");
    const { stdin, lastFrame } = mount();
    await flush();
    stdin.write(ENTER);
    await flush();
    stdin.write("f");
    await flush();
    await flush();
    expect(plain(lastFrame())).toContain("传输记录损坏");
  });
});
