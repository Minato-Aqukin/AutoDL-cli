import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { normalizeSnapshot } from "../../src/core/schemas.js";
import { stringWidth } from "../../src/output/format.js";
import { bar, sparkline } from "../../src/tui/components/meters.js";
import type { DashboardRow } from "../../src/tui/data.js";
import { Dashboard } from "../../src/tui/screens/dashboard.js";
import { snapshotResponse } from "../fixtures/responses.js";

/**
 * The dashboard as a set of widgets, in the manner of `btm`.
 *
 * The list answers "what exists"; the panels answer "what is it doing" and "what is it
 * costing". The rules that matter are the same ones the cost columns already follow — a
 * figure that is not known is drawn as a dash, never as a zero or an empty bar — plus one
 * the flat table never had to worry about: the layout has to give way on a small terminal
 * rather than let Ink squeeze rows out of the frame or wrap them into fragments.
 */

const plain = (s: string | undefined) =>
  (s ?? "").replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");

function makeRow(name: string, overrides: Partial<DashboardRow> = {}): DashboardRow {
  return {
    instance: {
      uuid: `pro-${name}`,
      name,
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
      ...(overrides.instance ?? {}),
    },
    uptimeSeconds: 3600,
    priceYuanPerHour: 1.97,
    estimatedCostYuan: 1.97,
    ttlRemainingMs: 4_980_000,
    ttlSeconds: 7200,
    ...overrides,
  };
}

const snapshot = normalizeSnapshot(snapshotResponse.data);
const history = { cpu: [3, 40, 88, 22, 61], mem: [1, 3, 8, 6, 4] };
const balance = { balanceYuan: 120, accumulatedYuan: 880.2, voucherYuan: 0 };

function frameOf(options: {
  rows: DashboardRow[];
  selectedIndex?: number;
  width?: number;
  height?: number;
  withSnapshot?: boolean;
  withBalance?: boolean;
}): string {
  const width = options.width ?? 100;
  return plain(
    render(
      <Box width={width}>
        <Dashboard
          rows={options.rows}
          selectedIndex={options.selectedIndex ?? 0}
          loading={false}
          snapshot={options.withSnapshot === false ? undefined : snapshot}
          history={options.withSnapshot === false ? undefined : history}
          balance={options.withBalance === false ? null : balance}
          width={width}
          height={options.height ?? 34}
        />
      </Box>,
    ).lastFrame(),
  );
}

describe("bar", () => {
  it("keeps a block for any non-zero reading", () => {
    // 3% of a ten-wide bar rounds to nothing, and an entirely empty bar reads as idle.
    expect(bar(3, 10)).toBe("█░░░░░░░░░");
  });

  it("draws nothing at all for a true zero", () => {
    expect(bar(0, 10)).toBe("░░░░░░░░░░");
  });

  it("fills completely at 100 and never overflows its width", () => {
    expect(bar(100, 8)).toBe("████████");
    expect(bar(140, 8)).toBe("████████");
    expect(stringWidth(bar(55, 12))).toBe(12);
  });
});

describe("sparkline", () => {
  it("is right-aligned so the newest sample keeps its place while history fills", () => {
    const drawn = sparkline([100, 100], 5);
    expect(drawn).toHaveLength(5);
    expect(drawn.startsWith("   ")).toBe(true);
    expect(drawn.endsWith("██")).toBe(true);
  });

  it("scales against 0–100, not the series' own maximum", () => {
    // Auto-scaling would draw a flat 2% idle as a full-height mountain range.
    expect(sparkline([2, 2, 2], 3)).toBe("▁▁▁");
    expect(sparkline([100, 100, 100], 3)).toBe("███");
  });

  it("shows only the most recent samples once the window is full", () => {
    expect(sparkline([100, 100, 0, 0], 2)).toBe("▁▁");
  });
});

describe("the resource panel", () => {
  it("gauges CPU, memory and both disks for a running instance", () => {
    const out = frameOf({ rows: [makeRow("box")] });
    expect(out).toContain("资源");
    for (const label of ["CPU", "内存", "系统盘", "数据盘"]) {
      expect(out).toContain(label);
    }
    expect(out).toContain("258MB / 20.0GB");
  });

  it("draws a sparkline from the samples collected so far", () => {
    const out = frameOf({ rows: [makeRow("box")] });
    expect(out).toMatch(/[▁▂▃▄▅▆▇█]{3}/);
  });

  it("says why there is nothing to show for a stopped instance", () => {
    // Empty bars would claim a measurement of zero; there is no measurement at all.
    const stopped = makeRow("idle", {
      instance: { ...makeRow("idle").instance, status: "shutdown" },
    });
    const out = frameOf({ rows: [stopped], withSnapshot: false });
    expect(out).toContain("实例未运行");
    expect(out).not.toContain("0.0%");
  });

  it("waits rather than guessing while the snapshot is still in flight", () => {
    const out = frameOf({ rows: [makeRow("box")], withSnapshot: false });
    expect(out).toContain("正在获取用量…");
  });

  it("clips an overlong instance name out of the border", () => {
    const out = frameOf({ rows: [makeRow("x".repeat(60))] });
    expect(out).not.toContain("x".repeat(30));
  });
});

describe("the billing panel", () => {
  it("reports how long the balance lasts at the current burn rate", () => {
    // ¥120 at ¥1.97/hr is a little over 60 hours — the number that decides whether to
    // leave something running overnight.
    const out = frameOf({ rows: [makeRow("box")] });
    expect(out).toContain("续航");
    expect(out).toContain("2d12h");
  });

  it("burns down against every running instance, not just the selected one", () => {
    const out = frameOf({ rows: [makeRow("a"), makeRow("b")] });
    expect(out).toContain("¥3.94/时");
  });

  it("says there is no burn rate when nothing is running", () => {
    const stopped = makeRow("idle", {
      instance: { ...makeRow("idle").instance, status: "shutdown" },
      priceYuanPerHour: null,
      estimatedCostYuan: null,
    });
    const out = frameOf({ rows: [stopped], withSnapshot: false });
    expect(out).toContain("当前不产生费用");
  });

  it("flags an instance with no TTL, which is the one that runs all night", () => {
    const out = frameOf({ rows: [makeRow("box", { ttlRemainingMs: null })] });
    expect(out).toContain("不会自动关机");
  });
});

describe("every value sits under the label that names it", () => {
  /** Display column where `token` starts, counting CJK as two. */
  const columnOf = (line: string, token: string): number => {
    const index = line.indexOf(token);
    return index < 0 ? -1 : stringWidth(line.slice(0, index));
  };

  const stopped = makeRow("ddp-deploy", {
    instance: { ...makeRow("ddp-deploy").instance, status: "shutdown" },
    uptimeSeconds: null,
    priceYuanPerHour: null,
    estimatedCostYuan: null,
    ttlRemainingMs: -1000,
  });

  it("lines the header up with the cells beneath it", () => {
    // The header row had no cursor cell while every data row did, so the whole table sat
    // one column right of its own labels — uniformly, which reads as "the columns are
    // off" rather than as a missing character.
    const frame = frameOf({ rows: [stopped], withSnapshot: false });
    const lines = frame.split("\n");
    const header = lines.find((line) => line.includes("已开机")) ?? "";
    const data = lines.find((line) => line.includes("ddp-deploy")) ?? "";

    for (const [label, value] of [
      ["实例", "ddp-deploy"],
      ["状态", "shutdown"],
      ["GPU", "4090D"],
      ["地区", "北京B区"],
      ["TTL", "已超时"],
    ] as [string, string][]) {
      expect(columnOf(data, value), `${label} column`).toBe(columnOf(header, label));
    }
  });

  it("holds the alignment at a width that drops columns", () => {
    const frame = frameOf({ rows: [stopped], withSnapshot: false, width: 78 });
    const lines = frame.split("\n");
    const header = lines.find((line) => line.includes("已开机")) ?? "";
    const data = lines.find((line) => line.includes("ddp-deploy")) ?? "";

    expect(columnOf(data, "shutdown")).toBe(columnOf(header, "状态"));
    expect(columnOf(data, "已超时")).toBe(columnOf(header, "TTL"));
  });

  it("holds the alignment for the selected row, which carries the cursor", () => {
    const frame = frameOf({ rows: [makeRow("first"), stopped], selectedIndex: 1 });
    const lines = frame.split("\n");
    const header = lines.find((line) => line.includes("已开机")) ?? "";
    const data = lines.find((line) => line.includes("ddp-deploy")) ?? "";

    expect(data).toContain("›");
    expect(columnOf(data, "shutdown")).toBe(columnOf(header, "状态"));
  });
});

describe("rules between instances", () => {
  const RULE = "┈";

  it("separates one instance from the next", () => {
    const frame = frameOf({ rows: [makeRow("a"), makeRow("b")] });
    expect(frame).toContain(RULE);

    // Between rows, never above the first — a rule under the header would read as a
    // second header rather than as a divider.
    const lines = frame.split("\n");
    const first = lines.findIndex((line) => line.includes("  a "));
    const rule = lines.findIndex((line) => line.includes(RULE));
    expect(rule).toBeGreaterThan(first);
  });

  it("draws none for a single instance, which has nothing to be separated from", () => {
    expect(frameOf({ rows: [makeRow("only")] })).not.toContain(RULE);
  });

  it("gives them up rather than hide an instance behind one", () => {
    // Nine instances and rules between them is seventeen lines; the panel has fewer.
    const many = Array.from({ length: 9 }, (_, index) => makeRow(`inst-${index}`));
    const frame = frameOf({ rows: many, height: 30 });
    expect(frame).not.toContain(RULE);
    const shown = frame.split("\n").filter((line) => line.includes("running")).length;
    expect(shown).toBe(9);
  });
});

describe("the layout gives way on a small terminal", () => {
  const rows = [makeRow("a"), makeRow("b"), makeRow("c"), makeRow("d")];

  it("drops the panels rather than pushing the list out of the frame", () => {
    const tall = frameOf({ rows, height: 34 });
    const short = frameOf({ rows, height: 18 });
    expect(tall).toContain("资源");
    expect(short).not.toContain("资源");

    // The list survives, the selection is on screen, and the frame stays inside its
    // height — which is the whole point of giving the panels up.
    expect(short).toContain("›a");
    expect(short.split("\n").length).toBeLessThanOrEqual(18);
  });

  it("drops columns rather than wrapping every row in two", () => {
    // Overshooting the width does not truncate a row, it wraps it — which turned a
    // narrow terminal's list into double-spaced fragments.
    const out = frameOf({ rows, width: 78 });
    expect(out).not.toContain("地区");
    expect(out).toContain("估算费用");

    const dataLines = out.split("\n").filter((line) => line.includes("running"));
    expect(dataLines).toHaveLength(rows.length);
  });

  it("never draws a line wider than the terminal", () => {
    for (const width of [70, 78, 88, 100]) {
      const out = frameOf({ rows, width });
      for (const line of out.split("\n")) {
        expect(stringWidth(line), `${width} cols: ${line}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it("keeps the selection on screen when the list is longer than the panel", () => {
    const many = Array.from({ length: 40 }, (_, index) => makeRow(`inst-${index}`));
    const out = frameOf({ rows: many, selectedIndex: 30, height: 34 });
    expect(out).toContain("inst-30");
    // And the frame is still the height it was given, not forty rows tall.
    expect(out.split("\n").length).toBeLessThanOrEqual(34);
  });
});
