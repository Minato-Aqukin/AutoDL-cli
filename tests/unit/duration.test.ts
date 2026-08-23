import { describe, expect, it } from "vitest";
import { formatDuration, parseDuration } from "../../src/core/duration.js";
import { UsageError } from "../../src/core/errors.js";

describe("parseDuration", () => {
  it("parses every supported unit", () => {
    expect(parseDuration("30s")).toBe(30);
    expect(parseDuration("45m")).toBe(2700);
    expect(parseDuration("2h")).toBe(7200);
    expect(parseDuration("1d")).toBe(86_400);
  });

  it("accepts fractional values", () => {
    expect(parseDuration("1.5h")).toBe(5400);
  });

  it("treats a bare number as minutes", () => {
    expect(parseDuration("90")).toBe(5400);
  });

  it("is case-insensitive and tolerates whitespace", () => {
    expect(parseDuration(" 2H ")).toBe(7200);
  });

  it("rejects garbage with a usage error so the CLI exits 2", () => {
    expect(() => parseDuration("soon")).toThrow(UsageError);
    expect(() => parseDuration("")).toThrow(UsageError);
  });

  it("rejects zero and negative durations", () => {
    // A zero TTL would arm a timer that fires immediately.
    expect(() => parseDuration("0h")).toThrow(UsageError);
    expect(() => parseDuration("-1h")).toThrow(UsageError);
  });
});

describe("formatDuration", () => {
  it("renders compact human strings", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(7200)).toBe("2h");
    expect(formatDuration(9000)).toBe("2h30m");
    expect(formatDuration(90_000)).toBe("1d1h");
  });
});
