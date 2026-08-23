import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
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
