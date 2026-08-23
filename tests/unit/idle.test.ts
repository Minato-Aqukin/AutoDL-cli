import { describe, expect, it } from "vitest";
import { parseUtilisation } from "../../src/guard/idle.js";

describe("parseUtilisation", () => {
  it("parses a single-GPU nvidia-smi reading", () => {
    expect(parseUtilisation("0\n")).toBe(0);
    expect(parseUtilisation("97\n")).toBe(97);
  });

  it("averages across multiple GPUs", () => {
    expect(parseUtilisation("100\n0\n")).toBe(50);
    expect(parseUtilisation("10\n20\n30\n")).toBe(20);
  });

  it("ignores blank lines and stray whitespace", () => {
    expect(parseUtilisation("  42  \n\n")).toBe(42);
  });

  it("returns null when nvidia-smi produced nothing usable", () => {
    // The caller must not read this as "idle" — that would shut down a busy box.
    expect(parseUtilisation("")).toBeNull();
    expect(parseUtilisation("\n\n")).toBeNull();
    expect(parseUtilisation("command not found")).toBeNull();
  });
});
