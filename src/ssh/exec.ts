import type { Writable } from "node:stream";
import type { Client } from "ssh2";
import type { AutoDLClient } from "../core/client.js";
import { SSHError, TimeoutError } from "../core/errors.js";
import { type ConnectOptions, withSSH } from "./credentials.js";

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
}

function buildCommand(command: string, options: ExecOptions): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(options.env ?? {})) {
    parts.push(`export ${key}=${JSON.stringify(value)}`);
  }
  if (options.cwd) parts.push(`cd ${JSON.stringify(options.cwd)}`);
  parts.push(command);
  return parts.join(" && ");
}

/** Run one command over an already-open connection. */
export function execOnConnection(
  conn: Client,
  command: string,
  options: ExecOptions = {},
): Promise<ExecResult> {
  const capture = options.capture ?? true;
  const full = buildCommand(command, options);

  return new Promise((resolve, reject) => {
    conn.exec(full, { pty: options.pty ?? false }, (err, stream) => {
      if (err) {
        reject(new SSHError(`远程命令启动失败：${err.message}`, { cause: err }));
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = options.timeoutMs
        ? setTimeout(() => {
            settled = true;
            stream.close();
            reject(
              new TimeoutError(`远程命令超过 ${options.timeoutMs}ms 未结束，已终止`, {
                details: { command },
              }),
            );
          }, options.timeoutMs)
        : undefined;

      stream.on("data", (chunk: Buffer) => {
        if (capture) stdout += chunk.toString("utf8");
        options.stdout?.write(chunk);
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        if (capture) stderr += chunk.toString("utf8");
        options.stderr?.write(chunk);
      });
      stream.on("close", (code: number | null, signal: string | null) => {
        if (timer) clearTimeout(timer);
        if (settled) return;
        resolve({ exitCode: code ?? null, signal: signal ?? null, stdout, stderr });
      });
      stream.on("error", (streamErr: Error) => {
        if (timer) clearTimeout(timer);
        if (settled) return;
        reject(new SSHError(`远程命令执行出错：${streamErr.message}`, { cause: streamErr }));
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
