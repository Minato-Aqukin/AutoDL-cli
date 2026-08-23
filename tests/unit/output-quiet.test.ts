import { afterEach, describe, expect, it, vi } from "vitest";
import { configureOutput, debug, note, success, warn } from "../../src/output/format.js";

/**
 * Quiet mode exists for the TUI.
 *
 * Core helpers write progress straight to stderr — "正在开机…", sweep warnings, debug
 * lines. Inside a full-screen Ink app those land in the middle of the rendered frame
 * and corrupt the layout, so the TUI silences them and surfaces the same information
 * through its status bar instead.
 */

afterEach(() => {
  configureOutput({ json: false, color: true, verbose: false, quiet: false });
});

function captureStderr(fn: () => void): string {
  let captured = "";
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return captured;
}

describe("quiet mode", () => {
  it("silences every human-facing writer", () => {
    configureOutput({ quiet: true, verbose: true });
    const output = captureStderr(() => {
      note("正在开机…");
      success("完成");
      warn("关机未生效");
      debug("状态：running");
    });
    expect(output).toBe("");
  });

  it("lets them through again once cleared", () => {
    configureOutput({ quiet: false, verbose: true });
    const output = captureStderr(() => {
      note("正在开机…");
      warn("关机未生效");
      debug("状态：running");
    });
    expect(output).toContain("正在开机");
    expect(output).toContain("关机未生效");
    expect(output).toContain("状态：running");
  });

  it("is independent of --json", () => {
    // Silencing via json:true would have been a hack; the TUI is not emitting JSON.
    configureOutput({ quiet: true, json: false });
    expect(captureStderr(() => note("x"))).toBe("");
    configureOutput({ quiet: false, json: true });
    expect(captureStderr(() => note("x"))).toBe("");
  });
});
