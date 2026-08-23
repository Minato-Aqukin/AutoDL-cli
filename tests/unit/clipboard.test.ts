import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "../../src/tui/clipboard.js";

/**
 * Copying the SSH command.
 *
 * Two things matter here beyond "it works": the fallback has to exist, because the
 * common case for this tool is a terminal with no clipboard binary at all (SSH
 * sessions, containers, minimal images); and the result has to say which path it took,
 * since OSC 52 is fire-and-forget and many terminals disable it.
 */

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

function captureStdout(): { restore: () => void; written: () => string } {
  let buffer = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    buffer += String(chunk);
    return true;
  });
  return { restore: () => spy.mockRestore(), written: () => buffer };
}

describe("copyToClipboard", () => {
  it("copies through a native helper when one exists", async () => {
    // This machine has wl-copy/xclip; on a runner without either the OSC 52 branch
    // takes over, which the next test covers explicitly.
    const result = await copyToClipboard("ssh -p 12345 root@connect.example.com");
    expect(result.ok).toBe(true);
    expect(["native", "osc52"]).toContain(result.method);
  });

  it("falls back to OSC 52 when no helper is available", async () => {
    // Emptying PATH is the cleanest way to guarantee every candidate spawn fails.
    const path = process.env.PATH;
    process.env.PATH = "";
    const stdout = captureStdout();
    try {
      const result = await copyToClipboard("hello");
      expect(result.method).toBe("osc52");
      expect(result.note).toContain("OSC 52");
      // ESC ] 52 ; c ; <base64 of "hello"> BEL
      const expected = `${ESC}]52;c;${Buffer.from("hello", "utf8").toString("base64")}${BEL}`;
      expect(stdout.written()).toContain(expected);
    } finally {
      stdout.restore();
      process.env.PATH = path;
    }
  });

  it("base64-encodes UTF-8 correctly in the fallback", async () => {
    const path = process.env.PATH;
    process.env.PATH = "";
    const stdout = captureStdout();
    try {
      await copyToClipboard("中文 ssh");
      expect(stdout.written()).toContain(Buffer.from("中文 ssh", "utf8").toString("base64"));
    } finally {
      stdout.restore();
      process.env.PATH = path;
    }
  });

  it("always reports a method, so callers never claim more than happened", async () => {
    const path = process.env.PATH;
    process.env.PATH = "";
    const stdout = captureStdout();
    try {
      const result = await copyToClipboard("x");
      // "requested" rather than "done": the terminal never answers.
      expect(result.note).toBeTruthy();
    } finally {
      stdout.restore();
      process.env.PATH = path;
    }
  });
});
