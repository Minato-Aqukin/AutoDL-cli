import { execSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { AutoDLClient } from "../../src/core/client.js";
import {
  armTTLOverSSH,
  buildTTLSnippet,
  composeStartCommand,
  disarmTTLOverSSH,
} from "../../src/guard/ttl.js";
import type { ExecResult } from "../../src/ssh/exec.js";
import { mockFetch } from "../fixtures/mock-fetch.js";

// Captures the exact command armTTLOverSSH would send, so the test can parse it.
const ssh = vi.hoisted(() => ({
  commands: [] as string[],
  impl: null as null | ((command: string) => Promise<ExecResult>),
}));

vi.mock("../../src/ssh/exec.js", () => ({
  execCommand: vi.fn(async (_client: unknown, _uuid: string, command: string) => {
    ssh.commands.push(command);
    if (ssh.impl) return ssh.impl(command);
    return { exitCode: 0, signal: null, stdout: "", stderr: "" };
  }),
  execOnConnection: vi.fn(),
}));

describe("buildTTLSnippet", () => {
  const snippet = buildTTLSnippet(7200);

  it("schedules a detached shutdown at the requested delay", () => {
    expect(snippet).toContain("sleep 7200");
    expect(snippet).toContain("/usr/bin/shutdown -h now");
    // Must be backgrounded or it would block AutoDL's boot sequence, and the PID
    // record must follow the `&` with a plain space — `&;` is a syntax error that
    // aborts the whole script before anything runs.
    expect(snippet).toContain("& echo $! >");
    expect(snippet).not.toContain("&;");
  });

  it("contains no quote characters at all", () => {
    // This string is embedded in AutoDL's start_command field and we cannot see how
    // that value is re-parsed server-side. A subshell with && expresses the same
    // intent without a single quote to be mangled.
    expect(snippet).not.toMatch(/['"`]/);
  });

  it("uses shutdown's absolute path, since boot-time PATH is not guaranteed", () => {
    expect(snippet).toContain("/usr/bin/shutdown");
  });

  it("parses under `bash -n`", () => {
    execSync(`bash -n -c ${JSON.stringify(snippet)}`);
  });
});

describe("composeStartCommand", () => {
  it("returns undefined when there is neither a TTL nor a user command", () => {
    expect(composeStartCommand(undefined, undefined)).toBeUndefined();
    expect(composeStartCommand(0, "")).toBeUndefined();
  });

  it("returns just the user command when no TTL is set", () => {
    expect(composeStartCommand(undefined, "python train.py")).toBe("python train.py");
  });

  it("arms the timer before running the user command", () => {
    // Ordering matters: if the user command hangs or fails, the timer must already
    // be running, or the instance bills forever.
    const composed = composeStartCommand(3600, "python train.py") as string;
    expect(composed.indexOf("sleep 3600")).toBeLessThan(composed.indexOf("python train.py"));
  });

  it("keeps the user command intact including its own quoting", () => {
    const composed = composeStartCommand(60, `bash -c "echo hi"`) as string;
    expect(composed).toContain(`bash -c "echo hi"`);
  });
});

describe("arming the in-instance timer", () => {
  it("sends one background command that parses under `bash -n` (no `&;`)", async () => {
    ssh.commands.length = 0;
    const client = new AutoDLClient({ token: "t", fetchImpl: mockFetch([]).impl });
    await expect(armTTLOverSSH(client, "pro-1", 3600)).resolves.toBe(true);
    const sent = ssh.commands[0] ?? "";
    expect(sent).not.toContain("&;");
    expect(sent).toContain("& echo $! >");
    execSync(`bash -n -c ${JSON.stringify(sent)}`);
  });

  it("treats a live-timer report as a failed cancel, and a clean exit as success", async () => {
    const client = new AutoDLClient({ token: "t", fetchImpl: mockFetch([]).impl });
    ssh.impl = async () => ({ exitCode: 1, signal: null, stdout: "STILL_RUNNING\n", stderr: "" });
    await expect(disarmTTLOverSSH(client, "pro-1")).resolves.toBe(false);
    ssh.impl = async () => ({ exitCode: 0, signal: null, stdout: "OK\n", stderr: "" });
    await expect(disarmTTLOverSSH(client, "pro-1")).resolves.toBe(true);
  });
});
