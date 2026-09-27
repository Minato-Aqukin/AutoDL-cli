import type { Client, ClientChannel } from "ssh2";
import type { AutoDLClient } from "../core/client.js";
import { AutoDLError, SSHError, UsageError } from "../core/errors.js";
import { assertNotAborted, type CredentialOptions, withSSH } from "./credentials.js";

/**
 * Password-authenticated interactive shell over ssh2 with a PTY.
 *
 * Counterpart to `connectInteractive`'s system-OpenSSH handoff (kept for `-L`
 * and other raw ssh flags): the password travels only inside the SSH
 * handshake, held in memory for one connection via `withSSH` — never on a
 * command line, in a file, or in output. This module prints nothing, in
 * particular never credentials.
 *
 * Raw passthrough both ways (no emulation), so vim/tmux work. The remote PTY
 * is sized from the local terminal and synced on `resize`; `$TERM` is
 * inherited (`xterm-256color` fallback). Resolves the remote exit code (128
 * when killed by signal); a channel that closes without an exit status
 * rejects — that is a disconnect, never success. Failures surface as
 * `SSHError` with the original `cause` (auth failures included, never
 * hidden); retries are `withSSH`'s connect policy only, an open shell never
 * retries. Host keys are unchecked — AutoDL proxies recycle keys across
 * instances — same as every SSH path here. No auto-power unless
 * `options.autoStart` (costs money: caller MUST confirm first).
 *
 * Parent contract: call only inside `suspendTerminal(() =>
 * connectTerminal(...))` or after unmount. The parent owns the alt screen —
 * `runTui` renders manually, so Ink will not leave it: write LEAVE_ALT_SCREEN
 * before and ENTER_ALT_SCREEN + CLEAR after. This function owns stdin raw
 * mode, stdio bytes, PTY resize, and cleanup only: TTYs required
 * (`UsageError` otherwise), Ctrl-C goes remote (ISIG off), abort via
 * `options.signal`, raw mode restored and every added handler removed on
 * settle.
 */
export async function connectTerminal(
  client: AutoDLClient,
  uuid: string,
  options: CredentialOptions = {},
): Promise<number> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new UsageError("自动终端登录需要真实交互终端", {
      hint: "在管道、CI 或其他非 TTY 环境下请用 `autodl exec` 执行单条命令。",
    });
  }
  assertNotAborted(options.signal);

  return withSSH(client, uuid, (conn) => runShellSession(conn, options.signal), options);
}

/**
 * Open the shell channel. The signal may have aborted while `withSSH` was
 * connecting, and the connection may die before the channel opens — so the
 * pending open is guarded on both sides until the callback runs. A stray
 * channel that opens after an abort/disconnect is closed, never driven.
 */
function runShellSession(conn: Client, signal?: AbortSignal): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const cleanupPending = (): void => {
      signal?.removeEventListener("abort", onPendingAbort);
      conn.off("close", onConnClose);
      conn.off("error", onConnError);
    };
    const failPending = (err: unknown): void => {
      if (settled) return;
      settled = true;
      cleanupPending();
      try {
        conn.end();
      } catch {
        // Already dead; withSSH still ends it in its finally.
      }
      reject(err);
    };
    const onPendingAbort = (): void => {
      failPending(new AutoDLError("操作已取消"));
    };
    const onConnClose = (): void => {
      failPending(
        new SSHError("SSH 连接已断开，远程 Shell 未能启动", {
          hint: "实例可能正在重启，或网络中断；稍后重试。",
        }),
      );
    };
    const onConnError = (err: Error): void => {
      failPending(new SSHError(`SSH 连接出错：${err.message}`, { cause: err }));
    };

    // The abort listener below never fires for an already-aborted signal, so
    // check first: otherwise an abort during connect enters a live shell on an
    // exited app.
    if (signal?.aborted) {
      failPending(new AutoDLError("操作已取消"));
      return;
    }

    const stdout = process.stdout;
    const pty = {
      cols: stdout.columns ?? 80,
      rows: stdout.rows ?? 24,
      term: process.env.TERM || "xterm-256color",
    };
    signal?.addEventListener("abort", onPendingAbort, { once: true });
    conn.once("close", onConnClose);
    conn.once("error", onConnError);
    try {
      conn.shell(pty, (err, stream) => {
        if (settled) {
          try {
            stream?.close();
          } catch {
            // Already gone.
          }
          return;
        }
        cleanupPending();
        if (err || !stream) {
          settled = true;
          reject(
            new SSHError(
              `远程 Shell 启动失败：${(err as Error | undefined)?.message ?? "未知错误"}`,
              {
                hint: "连接本身已建立，但远端拒绝分配 Shell；稍后重试，或用 `autodl exec` 先验证连通性。",
                cause: err,
              },
            ),
          );
          return;
        }
        if (signal?.aborted) {
          settled = true;
          try {
            stream.close();
          } catch {
            // Already gone.
          }
          reject(new AutoDLError("操作已取消"));
          return;
        }
        driveSession(conn, stream, signal, resolve, reject);
      });
    } catch (err) {
      failPending(
        new SSHError(`远程 Shell 请求失败：${(err as Error)?.message ?? String(err)}`, {
          cause: err,
        }),
      );
    }
  });
}

/**
 * Wire the open channel to the real terminal until the remote side closes.
 * Everything added here is torn down in `cleanup`, which runs exactly once —
 * on remote close, channel error, abort, local stdio loss, or raw-mode
 * failure.
 */
function driveSession(
  conn: Client,
  stream: ClientChannel,
  signal: AbortSignal | undefined,
  resolve: (code: number) => void,
  reject: (err: unknown) => void,
): void {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const wasRaw = stdin.isRaw;
  let settled = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let gotExit = false;
  let connCause: unknown;

  const cleanup = (): void => {
    stdin.off("data", onStdinData);
    stdin.off("end", onStdinGone);
    stdin.off("close", onStdinGone);
    stdin.off("error", onStdinError);
    stdin.pause();
    stream.off("data", onStdoutData);
    stream.stderr.off("data", onStdoutData);
    stream.off("error", onStreamError);
    stream.off("exit", onStreamExit);
    stream.off("close", onStreamClose);
    stream.off("drain", onStreamDrain);
    stdout.off("drain", onStdoutDrain);
    stdout.off("error", onStdoutError);
    stdout.off("close", onStdoutGone);
    stdout.off("resize", onResize);
    conn.off("error", onConnError);
    signal?.removeEventListener("abort", onAbort);
    if (stdin.isTTY) {
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        // Terminal already gone; nothing left to restore.
      }
    }
  };
  const done = (code: number): void => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve(code);
  };
  const fail = (err: unknown): void => {
    if (settled) return;
    settled = true;
    cleanup();
    try {
      stream.close();
    } catch {
      // Already closing; withSSH still ends the connection in its finally.
    }
    reject(err);
  };

  // Local keystrokes -> remote, with backpressure: pause stdin while the
  // channel buffer is full, resume on drain.
  // NOTE: chunks may arrive as strings — Ink sets stdin utf8 encoding and it
  // persists across suspend — so accept both and pass through untouched.
  const onStdinData = (chunk: Buffer | string): void => {
    if (settled) return;
    let ok = true;
    try {
      ok = stream.write(chunk);
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (!ok) stdin.pause();
  };
  const onStdinGone = (): void => {
    fail(
      new SSHError("本地终端输入已关闭，远程 Shell 已断开", {
        hint: "终端可能被关闭；重新打开终端后再试。",
      }),
    );
  };
  const onStdinError = (err: Error): void => {
    fail(new SSHError(`本地终端输入出错：${err.message}`, { cause: err }));
  };
  const onStreamDrain = (): void => {
    if (!settled) stdin.resume();
  };
  // Remote output -> local stdout, with backpressure the other way: while
  // stdout is full, pause both the channel and its stderr reader — pausing
  // the channel alone would let extended data buffer without bound.
  const onStdoutData = (chunk: Buffer): void => {
    if (settled) return;
    let ok = true;
    try {
      ok = stdout.write(chunk);
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (!ok) {
      stream.pause();
      stream.stderr.pause();
    }
  };
  const onStdoutDrain = (): void => {
    if (settled) return;
    stream.resume();
    stream.stderr.resume();
  };
  const onStdoutError = (err: Error): void => {
    fail(new SSHError(`本地终端输出出错：${err.message}`, { cause: err }));
  };
  const onStdoutGone = (): void => {
    fail(
      new SSHError("本地终端输出已关闭，远程 Shell 已断开", {
        hint: "终端可能被关闭；重新打开终端后再试。",
      }),
    );
  };
  const onResize = (): void => {
    if (settled) return;
    try {
      stream.setWindow(stdout.rows ?? 24, stdout.columns ?? 80, 0, 0);
    } catch {
      // Channel already closing; the coming close event settles us.
    }
  };
  const onAbort = (): void => {
    fail(new AutoDLError("操作已取消"));
  };
  // Recorded only as the cause if the channel then drops without an exit
  // status. The channel close below is what settles, so a clean exit that
  // precedes the connection teardown still resolves.
  const onConnError = (err: Error): void => {
    connCause = err;
  };
  const onStreamError = (err: Error): void => {
    fail(new SSHError(`远程 Shell 出错：${err.message}`, { cause: err }));
  };
  const onStreamExit = (code: number | null, signalName?: string): void => {
    gotExit = true;
    exitCode = typeof code === "number" ? code : null;
    exitSignal = signalName ?? null;
  };
  const onStreamClose = (): void => {
    if (gotExit) {
      done(exitCode ?? (exitSignal ? 128 : 0));
      return;
    }
    // No exit status: the channel died with the connection (reboot, network
    // loss, server kill). Reporting 0 here would claim success for a session
    // whose fate is unknown.
    fail(
      new SSHError("远程连接已意外断开", {
        hint: "Shell 未正常退出（实例重启或网络中断都可能）；重连后检查远端进程状态。",
        cause: connCause,
      }),
    );
  };

  // The signal may have aborted between the shell opening and now; the abort
  // listener below never fires for an already-aborted signal, so check first
  // and never enter a live shell on an exited app.
  if (signal?.aborted) {
    try {
      stream.close();
    } catch {
      // Already gone.
    }
    reject(new AutoDLError("操作已取消"));
    return;
  }

  stream.on("data", onStdoutData);
  // A pty shell normally merges stderr into stdout, but pipe it too so nothing
  // a server sends as extended data is ever silently dropped.
  stream.stderr.on("data", onStdoutData);
  stream.on("error", onStreamError);
  stream.once("exit", onStreamExit);
  stream.on("close", onStreamClose);
  stream.on("drain", onStreamDrain);
  conn.once("error", onConnError);
  stdout.on("drain", onStdoutDrain);
  stdout.on("error", onStdoutError);
  stdout.on("close", onStdoutGone);
  stdout.on("resize", onResize);
  stdin.on("error", onStdinError);
  stdin.on("end", onStdinGone);
  stdin.on("close", onStdinGone);
  stdin.on("data", onStdinData);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    stdin.setRawMode(true);
  } catch (err) {
    fail(
      new SSHError(`无法接管本地终端：${(err as Error)?.message ?? String(err)}`, {
        hint: "终端可能在连接建立后被关闭；确认 stdin 仍是可用 TTY 后重试。",
        cause: err,
      }),
    );
    return;
  }
  stdin.resume();
}
