import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { execOnConnection } from "../../src/ssh/exec.js";

/**
 * How the remote command string is assembled.
 *
 * The login-shell default is not cosmetic: AutoDL images keep python, pip and conda in
 * `/root/miniconda3/bin`, which only reaches PATH through the login profile. A plain
 * non-interactive `ssh host "pip install ..."` exits 127 — measured on a live instance,
 * because `.bashrc` returns early at its "If not running interactively" guard.
 */

function fakeConnection(capture: { command?: string }) {
  return {
    exec(command: string, _opts: unknown, cb: (err: Error | null, stream: unknown) => void) {
      capture.command = command;
      const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
      stream.stderr = new EventEmitter();
      cb(null, stream);
      queueMicrotask(() => stream.emit("close", 0, null));
    },
  } as never;
}

async function assemble(command: string, options = {}): Promise<string> {
  const capture: { command?: string } = {};
  await execOnConnection(fakeConnection(capture), command, options);
  return capture.command as string;
}

describe("remote command assembly", () => {
  it("wraps in a login shell by default", async () => {
    expect(await assemble("pip install -r requirements.txt")).toBe(
      "bash -lc 'pip install -r requirements.txt'",
    );
  });

  it("can be opted out of", async () => {
    expect(await assemble("echo hi", { loginShell: false })).toBe("echo hi");
  });

  it("escapes single quotes so the wrapper cannot be broken out of", async () => {
    const assembled = await assemble("echo 'hello world'");
    expect(assembled).toBe(`bash -lc 'echo '\\''hello world'\\'''`);
  });

  it("keeps cwd and env inside the login shell", async () => {
    const assembled = await assemble("python train.py", {
      cwd: "/root/autodl-tmp/demo",
      env: { WANDB_MODE: "offline" },
    });
    expect(assembled).toContain("bash -lc");
    expect(assembled).toContain("export WANDB_MODE=");
    expect(assembled).toContain("cd ");
    // Order matters: env and cwd must be applied before the command runs.
    expect(assembled.indexOf("export")).toBeLessThan(assembled.indexOf("cd "));
    expect(assembled.indexOf("cd ")).toBeLessThan(assembled.indexOf("python train.py"));
  });
});

describe("remote command quoting and lifecycle", () => {
  it("single-quotes env values so `$` and backticks survive literally", async () => {
    expect(
      await assemble("echo hi", { env: { HF_TOKEN: "hf_ab`id`" }, loginShell: false }),
    ).toContain("export HF_TOKEN='hf_ab`id`'");
  });

  it("single-quotes cwd instead of double-quoting it", async () => {
    expect(await assemble("pwd", { cwd: "/root/my proj", loginShell: false })).toContain(
      "cd '/root/my proj'",
    );
  });

  it("rejects hostile env keys", () => {
    expect(() =>
      execOnConnection(fakeConnection({}), "echo hi", { env: { "A;touch /tmp/x;B": "v" } }),
    ).toThrow(/非法的环境变量名/);
  });

  it("reassembles utf8 split across chunks", async () => {
    const text = "训练完成：准确率 99%\n";
    const buf = Buffer.from(text, "utf8");
    const conn = {
      exec(_command: string, _opts: unknown, cb: (err: Error | null, stream: unknown) => void) {
        const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
        stream.stderr = new EventEmitter();
        cb(null, stream);
        queueMicrotask(() => {
          stream.emit("data", buf.subarray(0, 4));
          stream.emit("data", buf.subarray(4));
          stream.emit("exit", 0);
          stream.emit("close", 0, null);
        });
      },
    } as never;
    const result = await execOnConnection(conn, "echo", { capture: true });
    expect(result.stdout).toBe(text);
  });

  it("rejects a close that arrived without an exit as a disconnect", async () => {
    const conn = {
      exec(_command: string, _opts: unknown, cb: (err: Error | null, stream: unknown) => void) {
        const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
        stream.stderr = new EventEmitter();
        cb(null, stream);
        queueMicrotask(() => {
          stream.emit("data", Buffer.from("partial"));
          stream.emit("close", undefined, undefined);
        });
      },
    } as never;
    await expect(execOnConnection(conn, "python train.py")).rejects.toThrow(/意外断开/);
  });

  it("resolves when exit precedes close", async () => {
    const conn = {
      exec(_command: string, _opts: unknown, cb: (err: Error | null, stream: unknown) => void) {
        const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
        stream.stderr = new EventEmitter();
        cb(null, stream);
        queueMicrotask(() => {
          stream.emit("exit", 3);
          stream.emit("close", 3, null);
        });
      },
    } as never;
    const result = await execOnConnection(conn, "exit 3");
    expect(result.exitCode).toBe(3);
  });

  it("rejects immediately when already aborted", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      execOnConnection(fakeConnection({}), "sleep 99", { signal: controller.signal }),
    ).toThrow(/操作已取消/);
  });

  it("signals and closes the remote on mid-run abort", async () => {
    const signals: string[] = [];
    let closed = false;
    const conn = {
      exec(_command: string, _opts: unknown, cb: (err: Error | null, stream: unknown) => void) {
        const stream = new EventEmitter() as EventEmitter & {
          stderr: EventEmitter;
          close: () => void;
          signal: (n: string) => void;
        };
        stream.stderr = new EventEmitter();
        stream.close = () => {
          closed = true;
        };
        stream.signal = (n: string) => {
          signals.push(n);
        };
        cb(null, stream);
      },
    } as never;
    const controller = new AbortController();
    const pending = execOnConnection(conn, "sleep 99", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/操作已取消/);
    expect(closed || signals.includes("KILL")).toBe(true);
  });
});
