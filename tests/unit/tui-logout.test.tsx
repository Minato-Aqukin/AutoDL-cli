import { Buffer } from "node:buffer";
import { render } from "ink-testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardRow } from "../../src/tui/data.js";

/**
 * Leaving a session: on purpose, and against your will.
 *
 * A token can stop working while the dashboard is open — it expires, gets reset, or the
 * account's verification lapses — and until now that left the TUI polling a dead API
 * behind a frozen table, with quitting to the shell the only way out. Both exits now
 * lead to the same place: the login screen the TUI already opens with.
 */

const row: DashboardRow = {
  instance: {
    uuid: "pro-abc",
    name: "demo",
    status: "running",
    subStatus: null,
    machineId: null,
    regionSign: "bj-B2",
    regionName: "北京B区",
    chargeType: "payg",
    startMode: "gpu",
    gpuSpec: "4090D",
    gpuNum: 1,
    createdAt: null,
    startedAt: null,
    stoppedAt: null,
    expiredAt: null,
    timedShutdownAt: null,
  },
  uptimeSeconds: 60,
  priceYuanPerHour: 1.97,
  estimatedCostYuan: 0.03,
  ttlRemainingMs: 600_000,
  ttlSeconds: 7200,
};

/** Set before a render to make the API reject the token a tick after mount. */
const state = vi.hoisted(() => ({ authError: null as string | null }));
const clearToken = vi.hoisted(() => vi.fn());
const tryResolveToken = vi.hoisted(() => vi.fn());

vi.mock("../../src/tui/data.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tui/data.js")>();
  const { useEffect, useState } = await import("react");
  return {
    ...actual,
    useInstances: () => {
      const [authError, setAuthError] = useState<string | null>(null);
      // Delayed rather than immediate, so the test exercises a session dying under a
      // dashboard that was working a moment ago.
      useEffect(() => {
        if (!state.authError) return;
        const timer = setTimeout(() => setAuthError(state.authError), 5);
        return () => clearTimeout(timer);
      }, []);
      return {
        rows: [row],
        loading: false,
        error: authError,
        authError,
        lastUpdated: Date.now(),
        refresh: vi.fn(),
        snapshotFor: () => undefined,
        historyFor: () => undefined,
        loadSnapshot: vi.fn(),
      };
    },
    destroyInstance: vi.fn(),
    stopInstance: vi.fn(),
    startInstance: vi.fn(),
  };
});

// A plain function, not a vi.fn: the suite runs with `restoreMocks`, which would strip
// a mocked implementation before each test and leave the header awaiting `undefined`.
vi.mock("../../src/core/endpoints/account.js", () => ({
  getBalance: async () => ({ balanceYuan: 12, accumulatedYuan: 30, voucherYuan: 0 }),
}));

vi.mock("../../src/config/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/store.js")>();
  return { ...actual, clearToken, tryResolveToken };
});

const { App, Root } = await import("../../src/tui/app.js");

const plain = (s: string | undefined) =>
  (s ?? "").replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
const ENTER = "\r";
const ESC = String.fromCharCode(27);
const CTRL_D = String.fromCharCode(4);
const CTRL_L = String.fromCharCode(12);
const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

/**
 * Wait for a frame to contain something, rather than guessing how long it takes.
 *
 * A rejected token arrives from a timer, then needs a render, a passive effect and a
 * second render before the panel is on screen — a fixed sleep passes on a warm process
 * and fails on a cold one.
 *
 * The trailing beat matters as much as the wait: Ink swaps its stdin subscription in a
 * passive effect that runs after the commit, so a key written the instant a new screen
 * appears is still delivered to the one it replaced.
 */
async function until(read: () => string | undefined, want: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !plain(read()).includes(want)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await flush();
  return plain(read());
}

const client = {} as never;
const TOKEN = [
  "header",
  Buffer.from(JSON.stringify({ uid: 785976 })).toString("base64url"),
  "sig",
].join(".");

function mount(overrides: { tokenSource?: "flag" | "env" | "config" } = {}) {
  const onLogout = vi.fn();
  const result = render(
    <App
      client={client}
      token={TOKEN}
      tokenSource={overrides.tokenSource ?? "config"}
      onLogout={onLogout}
    />,
  );
  return { ...result, onLogout };
}

beforeEach(() => {
  state.authError = null;
  clearToken.mockReset();
  tryResolveToken.mockReset();
});

describe("logging out on purpose", () => {
  it("is advertised in the key help, with a lowercase letter", async () => {
    // The status bar carries the same list, but it is long enough to wrap mid-item at
    // typical widths; the help screen puts one binding per line. The letter is printed
    // all-lowercase because a capital would read as "hold shift", which this is not.
    const { stdin, lastFrame } = mount();
    await flush();
    stdin.write("?");
    await flush();
    const out = plain(lastFrame());
    expect(out).toContain("ctrl+l 退出登录");
    expect(out).not.toContain("Ctrl");
    // Two columns, because one binding per line no longer fits the 24-row terminal the
    // test renders into — and Ink drops the overflow silently rather than scrolling.
    expect(out).toContain("q 退出");
    expect(plain(lastFrame()).split("\n").length).toBeLessThanOrEqual(24);
  });

  it("asks for confirmation rather than logging out on the keystroke", async () => {
    const { stdin, lastFrame, onLogout } = mount();
    await flush();
    stdin.write(CTRL_L);
    await flush();
    expect(plain(lastFrame())).toContain("退出登录？");
    expect(onLogout).not.toHaveBeenCalled();
  });

  it("logs out once confirmed", async () => {
    const { stdin, onLogout } = mount();
    await flush();
    stdin.write(CTRL_L);
    await flush();
    stdin.write("y");
    await flush();
    expect(onLogout).toHaveBeenCalled();
  });

  it("stays logged in when the confirmation is dismissed", async () => {
    const { stdin, lastFrame, onLogout } = mount();
    await flush();
    stdin.write(CTRL_L);
    await flush();
    stdin.write(ESC);
    await flush();
    expect(onLogout).not.toHaveBeenCalled();
    expect(plain(lastFrame())).toContain("demo");
  });

  it.each(["l", "L"])("does nothing on an unmodified %s", async (key) => {
    // `l` sits a hand's width from `k`/`j`, and `L` is one slipped shift from it.
    // Losing a session to a typo is not acceptable, so the binding needs ctrl.
    const { stdin, lastFrame } = mount();
    await flush();
    stdin.write(key);
    await flush();
    expect(plain(lastFrame())).not.toContain("退出登录？");
  });

  it("warns when an env token will outrank whatever is saved next", async () => {
    const { stdin, lastFrame } = mount({ tokenSource: "env" });
    await flush();
    stdin.write(CTRL_L);
    await flush();
    expect(plain(lastFrame())).toContain("AUTODL_TOKEN");
  });

  it("says nothing about overrides for an ordinary saved token", async () => {
    const { stdin, lastFrame } = mount();
    await flush();
    stdin.write(CTRL_L);
    await flush();
    expect(plain(lastFrame())).not.toContain("AUTODL_TOKEN");
  });
});

describe("a token that dies mid-session", () => {
  const REJECTED = "Token 无效或已失效（HTTP 401）";

  it("says so, verbatim, instead of leaving a frozen dashboard", async () => {
    state.authError = REJECTED;
    const { lastFrame } = mount();
    const out = await until(lastFrame, "登录状态已失效");
    expect(out).toContain("登录状态已失效");
    expect(out).toContain(REJECTED);
  });

  it("offers the way back to the login screen", async () => {
    state.authError = REJECTED;
    const { stdin, lastFrame, onLogout } = mount();
    expect(await until(lastFrame, "Enter 重新登入")).toContain("Enter 重新登入");
    stdin.write(ENTER);
    await flush();
    expect(onLogout).toHaveBeenCalledWith(expect.stringContaining("失效"));
  });

  it("takes the dashboard's keys out of play while it is up", async () => {
    // Every one of them would only produce another 401.
    state.authError = REJECTED;
    const { stdin, lastFrame } = mount();
    await until(lastFrame, "登录状态已失效");
    stdin.write(CTRL_D);
    await flush();
    expect(plain(lastFrame())).not.toContain("释放实例");
    stdin.write("g");
    await flush();
    expect(plain(lastFrame())).toContain("登录状态已失效");
  });
});

describe("the round trip", () => {
  it("returns to the login screen, having cleared the saved token", async () => {
    tryResolveToken.mockReturnValue({ token: TOKEN, source: "config" });
    const { stdin, lastFrame } = render(<Root globals={{}} />);
    await flush();
    expect(plain(lastFrame())).toContain("demo");

    stdin.write(CTRL_L);
    await flush();
    stdin.write("y");
    await flush();

    expect(clearToken).toHaveBeenCalled();
    const out = plain(lastFrame());
    expect(out).toContain("配置 Token 登入");
    expect(out).toContain("已退出登录");
  });

  it("tells the user their env token is still in charge", async () => {
    tryResolveToken.mockReturnValue({ token: TOKEN, source: "env" });
    const { stdin, lastFrame } = render(<Root globals={{}} />);
    await flush();
    stdin.write(CTRL_L);
    await flush();
    stdin.write("y");
    await flush();
    expect(plain(lastFrame())).toContain("AUTODL_TOKEN");
  });

  it("lands on the login screen after the session expires", async () => {
    state.authError = "Token 无效或已失效（HTTP 401）";
    tryResolveToken.mockReturnValue({ token: TOKEN, source: "config" });
    const { stdin, lastFrame } = render(<Root globals={{}} />);
    await until(lastFrame, "登录状态已失效");
    stdin.write(ENTER);
    const out = await until(lastFrame, "配置 Token 登入");
    expect(out).toContain("配置 Token 登入");
    expect(out).toContain("已失效");
  });
});
