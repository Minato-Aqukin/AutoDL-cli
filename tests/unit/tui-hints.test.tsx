import { Buffer } from "node:buffer";
import { render } from "ink-testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIRM_KEYS } from "../../src/tui/components/confirm.js";
import type { DashboardRow } from "../../src/tui/data.js";

/**
 * The bottom bar has to name the keys that work *right now*.
 *
 * Every modal, the wizard and the help screen take the keyboard away from the dashboard,
 * and the bar used to keep advertising `s 开机 · ctrl+d 释放 · q 退出` underneath all of
 * them — where `q` cancels a dialog instead of quitting and the rest do nothing at all.
 * A key list that lies is worse than no key list.
 *
 * The selection is here for the same reason: the highlight and the keys have to agree on
 * which instance is selected.
 */

function makeRow(suffix: string): DashboardRow {
  return {
    instance: {
      uuid: `pro-${suffix}`,
      name: `demo-${suffix}`,
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
}

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  /** When set, the list becomes this shortly after mount — a poll landing under the user. */
  next: null as unknown[] | null,
}));
const start = vi.hoisted(() => vi.fn());

vi.mock("../../src/tui/data.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tui/data.js")>();
  const { useCallback, useEffect, useState } = await import("react");
  return {
    ...actual,
    useInstances: () => {
      const [rows, setRows] = useState(state.rows);
      useEffect(() => {
        if (!state.next) return;
        // Late enough that a test gets to press a key against the original list first.
        const timer = setTimeout(() => setRows(state.next as unknown[]), 120);
        return () => clearTimeout(timer);
      }, []);
      return {
        rows,
        loading: false,
        error: null,
        authError: null,
        lastUpdated: Date.now(),
        refresh: useCallback(() => setRows([...state.rows]), []),
        snapshotFor: () => undefined,
        loadSnapshot: vi.fn(),
      };
    },
    startInstance: start,
    stopInstance: vi.fn(),
    destroyInstance: vi.fn(),
  };
});

const { App } = await import("../../src/tui/app.js");

const plain = (s: string | undefined) =>
  (s ?? "").replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = () => wait(40);
const CTRL_D = String.fromCharCode(4);
const CTRL_L = String.fromCharCode(12);
const ESC = String.fromCharCode(27);
const ENTER = "\r";

/** The key list the bar is currently showing: the last line the frame ends on. */
const hintLine = (frame: string | undefined): string => {
  const lines = plain(frame)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  return (lines.at(-1) ?? "").trim();
};

/** The row the table has highlighted, which is the one the cursor marker sits on. */
const highlighted = (frame: string | undefined): string =>
  plain(frame)
    .split("\n")
    .find((line) => line.trimStart().startsWith("›")) ?? "";

const TOKEN = [
  "header",
  Buffer.from(JSON.stringify({ uid: 785976 })).toString("base64url"),
  "sig",
].join(".");

const mount = () =>
  render(<App client={{} as never} token={TOKEN} tokenSource="config" onLogout={vi.fn()} />);

beforeEach(() => {
  state.rows = [makeRow("1")];
  state.next = null;
  start.mockReset();
});

describe("the key hints name whoever owns the keyboard", () => {
  it("advertises the dashboard keys on the dashboard", async () => {
    const { lastFrame } = mount();
    await flush();
    expect(plain(lastFrame())).toContain("ctrl+d 释放");
  });

  it("switches to the modal's keys while a release confirmation is up", async () => {
    const { stdin, lastFrame } = mount();
    await flush();
    stdin.write(CTRL_D);
    await flush();
    expect(hintLine(lastFrame())).toBe(CONFIRM_KEYS);
  });

  it("stops advertising the dashboard actions under a confirmation", async () => {
    // `s` and `x` do nothing while the modal is up, and `q` cancels the dialog rather
    // than quitting the app. None of them belong on screen here.
    const { stdin, lastFrame } = mount();
    await flush();
    stdin.write(CTRL_D);
    await flush();
    const hints = hintLine(lastFrame());
    expect(hints).not.toContain("开机");
    expect(hints).not.toContain("关机");
    expect(hints).not.toContain("q 退出");
  });

  it("switches to the modal's keys while a logout confirmation is up", async () => {
    const { stdin, lastFrame } = mount();
    await flush();
    stdin.write(CTRL_L);
    await flush();
    expect(hintLine(lastFrame())).toBe(CONFIRM_KEYS);
  });

  it("says only Esc during the create wizard", async () => {
    // The wizard prints what Enter does at the step it is on; Esc is the one key true
    // at every step, so it is the only one the bar can safely add.
    const { stdin, lastFrame } = mount();
    await flush();
    stdin.write("n");
    await flush();
    const hints = hintLine(lastFrame());
    expect(hints).toContain("Esc 取消");
    expect(hints).not.toContain("ctrl+d");
  });

  it("says how to leave the help screen", async () => {
    const { stdin, lastFrame } = mount();
    await flush();
    stdin.write("?");
    await flush();
    expect(hintLine(lastFrame())).toBe("按任意键返回");
  });

  it("advertises the detail keys on the detail screen", async () => {
    const { stdin, lastFrame } = mount();
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(hintLine(lastFrame())).toContain("p 显示/隐藏密码");
  });
});

describe("the highlight and the action keys agree on the selection", () => {
  it("keeps a row highlighted when the list shrinks under the cursor", async () => {
    state.rows = [makeRow("1"), makeRow("2"), makeRow("3")];
    const { stdin, lastFrame } = mount();
    await flush();
    stdin.write("j");
    stdin.write("j");
    await flush();
    expect(highlighted(lastFrame())).toContain("demo-3");

    // One gets released elsewhere and the next poll brings back a shorter list.
    state.rows = [makeRow("1"), makeRow("2")];
    stdin.write("r");
    await flush();
    expect(highlighted(lastFrame())).toContain("demo-2");
  });

  it("acts on the instance it is highlighting", async () => {
    // The lookup used to be clamped while the highlight was not, so the table showed no
    // selection at all and `s` started an instance the user could not see was chosen.
    state.rows = [makeRow("1"), makeRow("2"), makeRow("3")];
    const { stdin, lastFrame } = mount();
    await flush();
    stdin.write("j");
    stdin.write("j");
    await flush();

    state.rows = [makeRow("1"), makeRow("2")];
    stdin.write("r");
    await flush();
    stdin.write("s");
    await flush();

    expect(highlighted(lastFrame())).toContain("demo-2");
    expect(start).toHaveBeenCalledWith(expect.anything(), "pro-2");
  });
});

describe("an action in flight", () => {
  it("does not trap the user on the detail screen", async () => {
    // Input used to be dropped on every screen but the dashboard while `busy` was set,
    // so an unrelated power-on held the detail screen shut — Esc included — until it
    // finished. Only the keys that start another action should be blocked.
    let finish: () => void = () => undefined;
    start.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );

    const { stdin, lastFrame } = mount();
    await flush();
    stdin.write("s");
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(plain(lastFrame())).toContain("实例详情");

    stdin.write(ESC);
    await flush();
    expect(plain(lastFrame())).not.toContain("实例详情");

    finish();
    await flush();
  });

  it("ignores a second power-on while the first is still running", async () => {
    let finish: () => void = () => undefined;
    start.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );

    const { stdin } = mount();
    await flush();
    stdin.write("s");
    await flush();
    stdin.write("s");
    await flush();
    expect(start).toHaveBeenCalledTimes(1);

    finish();
    await flush();
  });
});

describe("a detail screen whose instance disappears", () => {
  it("returns to the dashboard rather than titling the dashboard 实例详情", async () => {
    state.next = [];
    const { stdin, lastFrame } = mount();
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(plain(lastFrame())).toContain("实例详情");

    // The instance is released from another terminal and the poll returns nothing.
    await wait(150);
    const out = plain(lastFrame());
    expect(out).not.toContain("实例详情");
    expect(out).toContain("实例看板");
    // And the bar goes back to the dashboard's keys, not the detail screen's.
    expect(out).toContain("ctrl+d 释放");
    expect(out).not.toContain("p 显示/隐藏密码");
  });
});
