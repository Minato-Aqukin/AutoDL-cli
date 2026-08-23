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
 * AutoDL reassigns `ssh_port` and `root_password` on **every** power cycle, so a
 * snapshot taken before a stop/start is worthless. Nothing in this codebase may cache
 * credentials across calls — always come back through here.
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
 * Connects with fresh credentials and — because a port can rotate between the moment
 * we read the snapshot and the moment we dial — retries exactly once with a forced
 * credential refresh before giving up.
 */
export async function withSSH<T>(
  client: AutoDLClient,
  uuid: string,
  fn: (conn: Client, creds: SSHCredentials) => Promise<T>,
  options: ConnectOptions = {},
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) note(t("ssh.refreshing"));
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

  throw new SSHError(`无法连接到实例 ${uuid}`, {
    hint: "实例可能刚重启完成，稍后重试；或运行 `autodl info <id>` 手动核对 SSH 端口。",
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
