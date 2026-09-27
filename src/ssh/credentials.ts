import { setTimeout as delay } from "node:timers/promises";
import { Client } from "ssh2";
import type { AutoDLClient } from "../core/client.js";
import {
  getInstanceSnapshot,
  getInstanceStatus,
  powerOnInstance,
} from "../core/endpoints/instance.js";
import { AutoDLError, SSHError } from "../core/errors.js";
import { waitForRunning, waitForShutdown } from "../core/waiters.js";
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
  assertNotAborted(options.signal);
  let status = await getInstanceStatus(client, uuid);
  assertNotAborted(options.signal);

  if (status !== "running") {
    if (!options.autoStart) {
      throw new SSHError(`实例 ${uuid} 当前状态为 "${status}"，无法建立 SSH 连接`, {
        hint: "先运行 `autodl start <id>`，或加 --start 让命令自动开机。",
        details: { status },
      });
    }
    // A mid-shutdown instance can't be powered on yet, and waiting for `running`
    // directly would hang until the timeout. Let it settle first.
    if (status === "shutting_down") {
      note("实例正在关机中，等待关机完成后再开机…");
      status = await waitForShutdown(client, uuid, {
        ...(options.waitTimeoutMs !== undefined ? { timeoutMs: options.waitTimeoutMs } : {}),
        ...(options.pollIntervalMs !== undefined ? { intervalMs: options.pollIntervalMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    }

    if (status === "shutdown") {
      assertNotAborted(options.signal);
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
  assertNotAborted(options.signal);
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

async function connectOnce(creds: SSHCredentials, options: ConnectOptions): Promise<Client> {
  assertNotAborted(options.signal);
  const { promise, resolve, reject } = Promise.withResolvers<Client>();
  const conn = new Client();
  let settled = false;
  const settle = (err?: Error) => {
    if (settled) return;
    settled = true;
    conn.off("ready", onReady);
    if (err) {
      // Destroying an unfinished SSH handshake emits a final protocol error before close.
      conn.once("close", () => conn.off("error", onError));
    } else {
      conn.off("error", onError);
    }
    conn.off("close", onClose);
    options.signal?.removeEventListener("abort", onAbort);
    if (err) reject(err);
    else resolve(conn);
  };
  const onReady = () => settle();
  const onError = (err: Error) => {
    if (settled) return;
    settle(err);
    conn.end();
  };
  const onClose = () => {
    settle(new SSHError("SSH 连接在握手完成前关闭"));
    conn.off("error", onError);
  };
  const onAbort = () => {
    settle(new AutoDLError("操作已取消"));
    conn.destroy();
  };
  conn.once("ready", onReady);
  conn.on("error", onError);
  conn.once("close", onClose);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    conn.connect({
      host: creds.host,
      port: creds.port,
      username: creds.user,
      password: creds.password,
      readyTimeout: options.connectTimeoutMs ?? 30_000,
      keepaliveInterval: options.keepaliveIntervalMs ?? 15_000,
    });
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
  }
  return promise;
}

/**
 * The single funnel for every one-shot SSH operation.
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
  const conn = await connectSSH(client, uuid, options);
  const creds = (conn as unknown as { _creds?: SSHCredentials })._creds;
  try {
    // Fresh per connection, never cached across calls: connectSSH attaches the
    // credentials used for this handshake and we detach them before closing.
    if (!creds) throw new SSHError("SSH 连接缺少凭证上下文", { details: { uuid } });
    return await fn(conn, creds);
  } finally {
    delete (conn as unknown as { _creds?: SSHCredentials })._creds;
    conn.end();
  }
}

/**
 * Build one authenticated connection and hand ownership to the caller.
 *
 * Same retry policy as `withSSH` (fresh credentials per attempt, spaced retries
 * for sshd-not-up-yet and port reassignment), except nothing is closed: the
 * caller MUST eventually call `conn.end()`. Used for the file view's reusable
 * browsing connection; one-shot operations should keep using `withSSH`.
 */
export async function connectSSH(
  client: AutoDLClient,
  uuid: string,
  options: ConnectOptions = {},
): Promise<Client> {
  let lastError: unknown;
  const attempts = Math.max(1, options.connectAttempts ?? 3);

  for (let attempt = 0; attempt < attempts; attempt++) {
    assertNotAborted(options.signal);
    if (attempt > 0) {
      note(t("ssh.refreshing"));
      await delay(RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1) ?? 5_000, undefined, {
        signal: options.signal,
      });
    }
    const creds = await getCredentials(client, uuid, options);
    assertNotAborted(options.signal);

    try {
      const conn = await connectOnce(creds, options);
      (conn as unknown as { _creds?: SSHCredentials })._creds = creds;
      return conn;
    } catch (err) {
      assertNotAborted(options.signal);
      if (err instanceof Error && "level" in err && err.level === "client-authentication") {
        throw new SSHError("SSH 认证失败，请重新获取实例凭证", { cause: err });
      }
      lastError = err;
      debug(`SSH 连接 ${creds.host}:${creds.port} 失败：${(err as Error).message}`);
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
