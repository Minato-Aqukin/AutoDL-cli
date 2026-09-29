import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { Client, ClientChannel } from "ssh2";
import type { AutoDLClient } from "../core/client.js";
import { AutoDLError, SSHError, TimeoutError } from "../core/errors.js";
import { assertNotAborted, type ConnectOptions, shellQuote, withSSH } from "./credentials.js";

export interface ExecResult {
  /** Remote process exit code. `null` when the process was killed by a signal. */
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

export interface ExecOptions extends ConnectOptions {
  /** Mirror remote output to these streams as it arrives. */
  stdout?: Writable;
  stderr?: Writable;
  /** Capture output into the result. Off for huge jobs to bound memory. */
  capture?: boolean;
  /** Kill the remote command after this many ms. */
  timeoutMs?: number;
  /** Working directory on the remote host. */
  cwd?: string;
  /** Extra environment variables exported before the command runs. */
  env?: Record<string, string>;
  /** Request a PTY — needed for programs that check isatty (e.g. progress bars). */
  pty?: boolean;
  /**
   * Run through a login shell (default true).
   *
   * AutoDL images put python/pip/conda in `/root/miniconda3/bin`, which reaches PATH
   * only via the login profile. A non-interactive `ssh host "cmd"` gets a bare PATH —
   * `.bashrc` bails out at the standard "If not running interactively, don't do
   * anything" guard — so `pip install` there fails with exit 127. A login shell matches
   * what the user sees when they `autodl ssh` in by hand.
   */
  loginShell?: boolean;
}

function buildCommand(command: string, options: ExecOptions): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new SSHError(`非法的环境变量名：${key}`, {
        hint: "变量名须以字母或下划线开头，仅含字母、数字和下划线。",
      });
    }
    parts.push(`export ${key}=${shellQuote(value)}`);
  }
  if (options.cwd) parts.push(`cd ${shellQuote(options.cwd)}`);
  parts.push(command);
  const inner = parts.join(" && ");

  return options.loginShell === false ? inner : `bash -lc ${shellQuote(inner)}`;
}

/** Run one command over an already-open connection. */
export function execOnConnection(
  conn: Client,
  command: string,
  options: ExecOptions = {},
): Promise<ExecResult> {
  const capture = options.capture ?? true;
  const signal = options.signal;
  assertNotAborted(signal);
  const full = buildCommand(command, options);
  return new Promise((resolve, reject) => {
    let openFailed = (err: Error): void => {
      reject(new SSHError(`远程命令启动失败：${err.message}`, { cause: err }));
    };
    const onAbortBeforeOpen = (): void => {
      // conn.exec is already in flight or about to run: swap the opener error
      // for cancellation so a late channel is closed, never awaited.
      openFailed = (err: Error) => {
        reject(err);
      };
    };
    // `assertNotAborted` above already handled the already-aborted case; the
    // listener below swaps the opener error for cancellation if abort lands
    // while conn.exec is in flight.
    signal?.addEventListener("abort", onAbortBeforeOpen, { once: true });
    conn.exec(full, { pty: options.pty ?? false }, (err, stream: ClientChannel) => {
      signal?.removeEventListener("abort", onAbortBeforeOpen);
      if (err) {
        openFailed(err);
        return;
      }
      if (signal?.aborted) {
        try {
          stream.close();
        } catch {
          // Already gone.
        }
        reject(new AutoDLError("操作已取消"));
        return;
      }

      const outDecoder = new StringDecoder("utf8");
      const errDecoder = new StringDecoder("utf8");
      let stdout = "";
      let stderr = "";
      let settled = false;
      let gotExit = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const kill = (): void => {
        try {
          stream.signal("KILL");
        } catch {
          // Not all servers accept signals; close() below still releases us.
        }
        try {
          stream.close();
        } catch {
          // Already gone.
        }
      };
      const timer = options.timeoutMs
        ? setTimeout(() => {
            kill();
            finish(() =>
              reject(
                new TimeoutError(`远程命令超过 ${options.timeoutMs}ms 未结束，已终止`, {
                  details: { command },
                }),
              ),
            );
          }, options.timeoutMs)
        : undefined;
      // AbortSignal.timeout() also unrefs its timer; keep ours referenced so a
      // long remote command can't let the process exit early.
      timer?.ref?.();
      const onAbort = (): void => {
        kill();
        finish(() => reject(new AutoDLError("操作已取消")));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      stream.on("data", (chunk: Buffer) => {
        if (capture) stdout += outDecoder.write(chunk);
        options.stdout?.write(chunk);
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        if (capture) stderr += errDecoder.write(chunk);
        options.stderr?.write(chunk);
      });
      // `exit` fires only when the server reports a status; `close` always
      // fires, with garbage (undefined) when the channel died with the
      // connection. A close without a prior exit is a disconnect, not a
      // result — resolving it would report a kill as success.
      stream.once("exit", () => {
        gotExit = true;
      });
      stream.on("close", (code: number | null, sig: string | null) => {
        if (capture) {
          stdout += outDecoder.end();
          stderr += errDecoder.end();
        }
        if (!gotExit && typeof code !== "number" && typeof sig !== "string") {
          finish(() =>
            reject(
              new SSHError("远程连接已意外断开", {
                hint: "命令未正常结束（实例重启或网络中断都可能）；重连后检查远端进程状态。",
                details: { command },
              }),
            ),
          );
          return;
        }
        finish(() => resolve({ exitCode: code ?? null, signal: sig ?? null, stdout, stderr }));
      });
      stream.on("error", (streamErr: Error) => {
        finish(() =>
          reject(new SSHError(`远程命令执行出错：${streamErr.message}`, { cause: streamErr })),
        );
      });
    });
  });
}

/** Connect (refreshing credentials as needed) and run a single command. */
export async function execCommand(
  client: AutoDLClient,
  uuid: string,
  command: string,
  options: ExecOptions = {},
): Promise<ExecResult> {
  return withSSH(client, uuid, (conn) => execOnConnection(conn, command, options), options);
}
