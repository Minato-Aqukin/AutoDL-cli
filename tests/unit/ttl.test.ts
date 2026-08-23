import { describe, expect, it } from "vitest";
import { buildTTLSnippet, composeStartCommand } from "../../src/guard/ttl.js";

describe("buildTTLSnippet", () => {
  const snippet = buildTTLSnippet(7200);

  it("schedules a detached shutdown at the requested delay", () => {
    expect(snippet).toContain("sleep 7200");
    expect(snippet).toContain("/usr/bin/shutdown -h now");
    // Must be backgrounded or it would block AutoDL's boot sequence.
    expect(snippet.trimEnd().endsWith("&")).toBe(true);
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
