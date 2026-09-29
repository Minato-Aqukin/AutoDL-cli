import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutoDLClient } from "../../src/core/client.js";
import { NotFoundError, SSHError, UsageError } from "../../src/core/errors.js";
import { parseUtilisation, watchIdle } from "../../src/guard/idle.js";
import type { ExecResult } from "../../src/ssh/exec.js";
import { mockFetch } from "../fixtures/mock-fetch.js";

const POWER_OFF = "/api/v1/dev/instance/pro/power_off";

// Captures how many samples ran without touching the network for SSH.
const ssh = vi.hoisted(() => ({
  calls: 0,
  impl: null as null | (() => Promise<ExecResult>),
}));

vi.mock("../../src/ssh/exec.js", () => ({
  execCommand: vi.fn(async () => {
    ssh.calls += 1;
    if (ssh.impl) return ssh.impl();
    return { exitCode: 0, signal: null, stdout: "0\n", stderr: "" };
  }),
  execOnConnection: vi.fn(),
}));

const client = (fetchImpl: typeof fetch) =>
  new AutoDLClient({ token: "t", fetchImpl, retryBaseDelayMs: 1 });

beforeEach(() => {
  ssh.calls = 0;
  ssh.impl = null;
});

describe("parseUtilisation", () => {
  it("parses a single-GPU nvidia-smi reading", () => {
    expect(parseUtilisation("0\n")).toBe(0);
    expect(parseUtilisation("97\n")).toBe(97);
  });

  it("averages across multiple GPUs", () => {
    expect(parseUtilisation("100\n0\n")).toBe(50);
    expect(parseUtilisation("10\n20\n30\n")).toBe(20);
  });

  it("ignores blank lines and stray whitespace", () => {
    expect(parseUtilisation("  42  \n\n")).toBe(42);
  });

  it("returns null when nvidia-smi produced nothing usable", () => {
    // The caller must not read this as "idle" — that would shut down a busy box.
    expect(parseUtilisation("")).toBeNull();
    expect(parseUtilisation("\n\n")).toBeNull();
    expect(parseUtilisation("command not found")).toBeNull();
  });
});

describe("idle cancellation and dead instances", () => {
  it("does not power off when the abort lands during the sample", async () => {
    const controller = new AbortController();
    ssh.impl = async () => {
      controller.abort();
      return { exitCode: 0, signal: null, stdout: "0\n", stderr: "" };
    };
    const fetchMock = mockFetch([
      { path: POWER_OFF, response: { code: "Success", msg: "", data: null } },
    ]);
    const result = await watchIdle(client(fetchMock.impl), "pro-1", {
      samples: 1,
      intervalSeconds: 60,
      signal: controller.signal,
    });
    expect(result).toMatchObject({ stopped: false, reason: "aborted" });
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("reports not-running when the instance is already shut down", async () => {
    ssh.impl = async () => {
      throw new SSHError('实例 pro-1 当前状态为 "shutdown"，无法建立 SSH 连接', {
        details: { status: "shutdown" },
      });
    };
    const result = await watchIdle(client(mockFetch([]).impl), "pro-1", {
      samples: 3,
      intervalSeconds: 60,
    });
    expect(result).toMatchObject({ stopped: false, reason: "not-running" });
    expect(ssh.calls).toBe(1);
  });

  it("reports not-running for a released instance", async () => {
    ssh.impl = async () => {
      throw new NotFoundError("实例不存在");
    };
    const result = await watchIdle(client(mockFetch([]).impl), "pro-1", {
      samples: 3,
      intervalSeconds: 60,
    });
    expect(result.reason).toBe("not-running");
  });

  it("rides out transient connection hiccups without ending the watch", async () => {
    let calls = 0;
    ssh.impl = async () => {
      calls++;
      if (calls <= 2) throw new SSHError("dial tcp: connection refused");
      return { exitCode: 0, signal: null, stdout: "0\n", stderr: "" };
    };
    const result = await watchIdle(client(mockFetch([]).impl), "pro-1", {
      samples: 1,
      intervalSeconds: 0.01,
      dryRun: true,
    });
    expect(result.reason).toBe("dry-run");
    expect(calls).toBeGreaterThan(2);
  });
});

describe("idle option validation", () => {
  it.each([0, -1, 1.5, Number.NaN])("rejects samples=%s with a usage error", async (samples) => {
    await expect(watchIdle(client(mockFetch([]).impl), "pro-1", { samples })).rejects.toThrow(
      UsageError,
    );
  });
  it("rejects a non-finite threshold with a usage error", async () => {
    await expect(
      watchIdle(client(mockFetch([]).impl), "pro-1", { thresholdPercent: Number.NaN }),
    ).rejects.toThrow(UsageError);
  });
});
