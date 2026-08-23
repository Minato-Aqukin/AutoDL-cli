import { Client } from "ssh2";
import type { AutoDLClient } from "../core/client.js";
import {
  getInstanceSnapshot,
  getInstanceStatus,
  powerOnInstance,
} from "../core/endpoints/instance.js";
import { AutoDLError, SSHError } from "../core/errors.js";
import { waitForRunning } from "../core/waiters.js";
import { debug, note } from "../output/format.js";
import { t } from "../output/i18n.js";

export interface SSHCredentials {
  uuid: string;
  host: string;
  port: number;
  user: "root";
  password: string;
}

export interface CredentialOptions {
  /** Power the instance on (and wait) when it isn't running. */
  autoStart?: boolean;
  /** How long to wait for `running` when auto-starting. */
  waitTimeoutMs?: number;
  /** Gap between status polls while waiting. */
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

/**
 * Fetch live SSH credentials for an instance.
 *
 * AutoDL may reassign `ssh_port` and `root_password` on any power cycle — the instance
 * can be rescheduled onto a different machine. It does not always happen (a real
 * stop/start was observed keeping both identical), which is exactly why caching is
 * unsafe: the stale value works often enough to hide the bug. Nothing in this codebase
 * may cache credentials across calls — always come back through here.
 */
export async function getCredentials(
  client: AutoDLClient,
  uuid: string,
  options: CredentialOptions = {},
): Promise<SSHCredentials> {
  let status = await getInstanceStatus(client, uuid);

  if (status !== "running") {
    if (!options.autoStart) {
      throw new SSHError(`实例 ${uuid} 当前状态为 "${status}"，无法建立 SSH 连接`, {
        hint: "先运行 `autodl start <id>`，或加 --start 让命令自动开机。",
        details: { status },
      });
    }
    if (status === "shutdown") {
      note(t("instance.poweringOn"));
      await powerOnInstance(client, uuid);
    }
    status = await waitForRunning(client, uuid, {
      ...(options.waitTimeoutMs !== undefined ? { timeoutMs: options.waitTimeoutMs } : {}),
      ...(options.pollIntervalMs !== undefined ? { intervalMs: options.pollIntervalMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      onPoll: (s) => debug(`实例 ${uuid} 状态：${s}`),
    });
  }

  const snapshot = await getInstanceSnapshot(client, uuid);
  const { host, port, password } = snapshot.ssh;

  if (!host || !port || !password) {
    throw new SSHError(`实例 ${uuid} 尚未返回完整的 SSH 信息`, {
      hint: "实例可能仍在启动中，稍等片刻后重试。",
      details: { host, port, hasPassword: Boolean(password) },
    });
  }
  return { uuid, host, port, user: "root", password };
}

export interface ConnectOptions extends CredentialOptions {
  /** Socket-level connect timeout. */
  connectTimeoutMs?: number;
  keepaliveIntervalMs?: number;
  /** Connection attempts before giving up. Each one re-reads the credentials. */
  connectAttempts?: number;
}

/**
 * Backoff between connection attempts.
 *
 * A freshly created instance reports `running` before sshd is accepting connections —
 * observed on a real 4090D, where the first connect was refused and only the retry
 * succeeded. Retrying instantly would just fail again, so wait a little between tries.
 */
const RETRY_DELAYS_MS = [2_000, 5_000, 8_000];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectOnce(creds: SSHCredentials, options: ConnectOptions): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const settle = (err?: Error) => {
      conn.removeAllListeners("ready");
      conn.removeAllListeners("error");
      if (err) reject(err);
      else resolve(conn);
    };
    conn.once("ready", () => settle());
    conn.once("error", (err) => {
      conn.end();
      settle(err);
    });
    conn.connect({
      host: creds.host,
      port: creds.port,
      username: creds.user,
      password: creds.password,
      readyTimeout: options.connectTimeoutMs ?? 30_000,
      keepaliveInterval: options.keepaliveIntervalMs ?? 15_000,
      // AutoDL's proxy hosts reuse addresses across instances, so a known_hosts
      // check would fail constantly and teach users to ignore warnings.
      algorithms: undefined,
    });
  });
}

/**
 * The single funnel for every SSH operation.
 *
 * Each attempt re-reads the credentials, which covers both ways a connection can fail:
 * the port may have been reassigned since the snapshot was taken, and sshd may simply
 * not be up yet on a freshly booted instance. The first is fixed by the refresh, the
 * second only by waiting — so attempts are spaced out rather than fired back to back.
 */
export async function withSSH<T>(
  client: AutoDLClient,
  uuid: string,
  fn: (conn: Client, creds: SSHCredentials) => Promise<T>,
  options: ConnectOptions = {},
): Promise<T> {
  let lastError: unknown;
  const attempts = Math.max(1, options.connectAttempts ?? 3);

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      note(t("ssh.refreshing"));
      await delay(RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1) ?? 5_000);
    }
    const creds = await getCredentials(client, uuid, options);

    let conn: Client;
    try {
      conn = await connectOnce(creds, options);
    } catch (err) {
      lastError = err;
      debug(`SSH 连接 ${creds.host}:${creds.port} 失败：${(err as Error).message}`);
      continue;
    }

    try {
      return await fn(conn, creds);
    } finally {
      conn.end();
    }
  }

  throw new SSHError(`无法连接到实例 ${uuid}（已尝试 ${attempts} 次）`, {
    hint: "实例可能仍在启动中，稍后重试；或运行 `autodl info <id>` 手动核对 SSH 端口。",
    cause: lastError,
  });
}

/** Shell-quote a value for safe interpolation into a remote command. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AutoDLError("操作已取消");
}
