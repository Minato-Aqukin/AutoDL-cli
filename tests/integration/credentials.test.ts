import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The scenario this file exists for: AutoDL reassigns `ssh_port` and `root_password`
 * on every power cycle. A connection built from a stale snapshot fails, and the CLI
 * has to notice, re-read the snapshot, and reconnect — without the caller knowing.
 */

interface FakeConnection {
  config: { host: string; port: number; password: string };
}

// Hoisted so the vi.mock factory (which vitest lifts to the top of the file) can
// reach this state without hitting a temporal dead zone.
const ssh = vi.hoisted(() => ({
  connections: [] as FakeConnection[],
  /** Ports a connection attempt should succeed on. Anything else is refused. */
  openPorts: new Set<number>(),
}));

vi.mock("ssh2", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  class FakeClient extends Emitter {
    connect(config: { host: string; port: number; password: string }) {
      ssh.connections.push({ config });
      queueMicrotask(() => {
        if (ssh.openPorts.has(config.port)) this.emit("ready");
        else this.emit("error", new Error(`connect ECONNREFUSED :${config.port}`));
      });
      return this;
    }
    end() {}
  }
  return { Client: FakeClient };
});

const { AutoDLClient } = await import("../../src/core/client.js");
const { getCredentials, withSSH } = await import("../../src/ssh/credentials.js");
const { SSHError } = await import("../../src/core/errors.js");
const { mockFetch } = await import("../fixtures/mock-fetch.js");
const { snapshotResponse, emptySuccess } = await import("../fixtures/responses.js");

const STATUS = "/api/v1/dev/instance/pro/status";
const SNAPSHOT = "/api/v1/dev/instance/pro/snapshot";
const POWER_ON = "/api/v1/dev/instance/pro/power_on";

const statusOk = (value: string) => ({ code: "Success", msg: "", data: value });

function snapshotWith(port: number, password: string) {
  return {
    ...snapshotResponse,
    data: { ...snapshotResponse.data, ssh_port: port, root_password: password },
  };
}

function client(fetchImpl: typeof fetch) {
  return new AutoDLClient({ token: "t", fetchImpl, retryBaseDelayMs: 1 });
}

beforeEach(() => {
  ssh.connections.length = 0;
  ssh.openPorts.clear();
});

describe("getCredentials", () => {
  it("reads the live snapshot for a running instance", async () => {
    const fetchMock = mockFetch([
      { path: STATUS, response: statusOk("running") },
      { path: SNAPSHOT, response: snapshotWith(34222, "pw-a") },
    ]);
    const creds = await getCredentials(client(fetchMock.impl), "pro-1");
    expect(creds).toEqual({
      uuid: "pro-1",
      host: "connect.xxx.autodl.com",
      port: 34222,
      user: "root",
      password: "pw-a",
    });
  });

  it("refuses to connect to a stopped instance unless autoStart is set", async () => {
    const fetchMock = mockFetch([{ path: STATUS, response: statusOk("shutdown") }]);
    await expect(getCredentials(client(fetchMock.impl), "pro-1")).rejects.toThrow(SSHError);
  });

  it("powers on and waits when autoStart is set", async () => {
    const fetchMock = mockFetch([
      // shutdown -> (power_on) -> starting -> running
      {
        path: STATUS,
        response: (_c, i) => statusOk(["shutdown", "starting", "running"][i] ?? "running"),
      },
      { path: POWER_ON, response: emptySuccess },
      { path: SNAPSHOT, response: snapshotWith(40001, "pw-new") },
    ]);
    const creds = await getCredentials(client(fetchMock.impl), "pro-1", {
      autoStart: true,
      waitTimeoutMs: 5_000,
      pollIntervalMs: 1,
    });
    expect(creds.port).toBe(40001);
    expect(fetchMock.calls.some((call) => call.url.includes("power_on"))).toBe(true);
  });

  it("errors clearly when the instance is up but SSH info isn't populated yet", async () => {
    const fetchMock = mockFetch([
      { path: STATUS, response: statusOk("running") },
      { path: SNAPSHOT, response: { code: "Success", msg: "", data: { region_sign: "bj-B1" } } },
    ]);
    await expect(getCredentials(client(fetchMock.impl), "pro-1")).rejects.toThrow(
      /完整的 SSH 信息/,
    );
  });
});

describe("withSSH credential rotation", () => {
  it("connects on the first try when the snapshot is fresh", async () => {
    ssh.openPorts.add(34222);
    const fetchMock = mockFetch([
      { path: STATUS, response: statusOk("running") },
      { path: SNAPSHOT, response: snapshotWith(34222, "pw-a") },
    ]);
    const result = await withSSH(
      client(fetchMock.impl),
      "pro-1",
      async (_conn, creds) => creds.port,
    );
    expect(result).toBe(34222);
    expect(ssh.connections).toHaveLength(1);
  });

  it("re-reads the snapshot and reconnects when the port has rotated", async () => {
    // Only the post-reboot port accepts connections.
    ssh.openPorts.add(40001);
    const fetchMock = mockFetch([
      { path: STATUS, response: statusOk("running") },
      {
        path: SNAPSHOT,
        // First read is stale (the pre-reboot port), second read is current.
        response: (_call, index) =>
          index === 0 ? snapshotWith(34222, "pw-old") : snapshotWith(40001, "pw-new"),
      },
    ]);

    const used = await withSSH(client(fetchMock.impl), "pro-1", async (_conn, creds) => creds);

    expect(ssh.connections.map((c) => c.config?.port)).toEqual([34222, 40001]);
    expect(used.port).toBe(40001);
    expect(used.password).toBe("pw-new");
  });

  it("gives up after the attempt budget and reports an SSH failure (exit 8)", async () => {
    const fetchMock = mockFetch([
      { path: STATUS, response: statusOk("running") },
      { path: SNAPSHOT, response: snapshotWith(34222, "pw-a") },
    ]);
    await expect(
      // connectAttempts: 2 keeps the test off the real backoff schedule.
      withSSH(client(fetchMock.impl), "pro-1", async () => "unreachable", {
        connectAttempts: 2,
      }),
    ).rejects.toThrow(SSHError);
    expect(ssh.connections).toHaveLength(2);
  });

  it("waits between attempts, since an instant retry cannot fix a slow-booting sshd", async () => {
    // Observed on a real instance: AutoDL reports `running` before sshd accepts
    // connections. Firing retries back to back would just fail three times fast.
    ssh.openPorts.add(34222);
    const fetchMock = mockFetch([
      { path: STATUS, response: statusOk("running") },
      {
        path: SNAPSHOT,
        // Only the second read yields a port the fake server will accept.
        response: (_call, index) =>
          index === 0 ? snapshotWith(59999, "pw-a") : snapshotWith(34222, "pw-a"),
      },
    ]);

    const started = Date.now();
    await withSSH(client(fetchMock.impl), "pro-1", async (_conn, creds) => creds.port);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
  }, 20_000);

  it("does not swallow an error thrown by the caller's own callback", async () => {
    ssh.openPorts.add(34222);
    const fetchMock = mockFetch([
      { path: STATUS, response: statusOk("running") },
      { path: SNAPSHOT, response: snapshotWith(34222, "pw-a") },
    ]);
    await expect(
      withSSH(client(fetchMock.impl), "pro-1", async () => {
        throw new Error("caller blew up");
      }),
    ).rejects.toThrow("caller blew up");
    // A failure inside the callback is not a connection problem — don't retry it.
    expect(ssh.connections).toHaveLength(1);
  });
});
