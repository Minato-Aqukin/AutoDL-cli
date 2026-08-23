import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { GPU_SPECS } from "../../src/core/catalog.js";
import { stringWidth } from "../../src/output/format.js";
import { Confirm } from "../../src/tui/components/confirm.js";
import { Header } from "../../src/tui/components/header.js";
import { StatusBar } from "../../src/tui/components/statusbar.js";
import type { DashboardRow } from "../../src/tui/data.js";
import { equivalentCommand } from "../../src/tui/screens/create.js";
import { Dashboard } from "../../src/tui/screens/dashboard.js";
import { toStockRows } from "../../src/tui/screens/stock.js";

/** Strip ANSI so assertions read on content rather than colour codes. */
const plain = (s: string | undefined) =>
  (s ?? "").replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");

const ENTER = "\r";

function row(overrides: Partial<DashboardRow> = {}): DashboardRow {
  return {
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
    uptimeSeconds: 3600,
    priceYuanPerHour: 1.97,
    estimatedCostYuan: 1.97,
    ttlRemainingMs: 600_000,
    ttlSeconds: 7200,
    ...overrides,
  };
}

describe("Dashboard", () => {
  it("renders an instance with its cost and TTL", () => {
    const { lastFrame } = render(<Dashboard rows={[row()]} selectedIndex={0} loading={false} />);
    const out = plain(lastFrame());
    expect(out).toContain("demo");
    expect(out).toContain("4090D×1");
    expect(out).toContain("北京B区");
    expect(out).toContain("≈¥1.97");
    expect(out).toContain("10m");
  });

  it("shows an ellipsis, not a zero, while the rate is unknown", () => {
    // ¥0.00 would read as "this is free". It is not.
    const { lastFrame } = render(
      <Dashboard
        rows={[row({ priceYuanPerHour: null, estimatedCostYuan: null })]}
        selectedIndex={0}
        loading={false}
      />,
    );
    const out = plain(lastFrame());
    expect(out).toContain("…");
    expect(out).not.toContain("¥0.00");
  });

  it("shows no cost at all for a stopped instance", () => {
    // AutoDL exposes a rate only for a running instance, so there is nothing honest
    // to print here.
    const stopped = row({
      instance: { ...row().instance, status: "shutdown" },
      uptimeSeconds: null,
      estimatedCostYuan: null,
    });
    const out = plain(
      render(<Dashboard rows={[stopped]} selectedIndex={0} loading={false} />).lastFrame(),
    );
    expect(out).toContain("shutdown");
    expect(out).not.toContain("¥");
  });

  it("flags an overdue TTL", () => {
    const out = plain(
      render(
        <Dashboard rows={[row({ ttlRemainingMs: -1000 })]} selectedIndex={0} loading={false} />,
      ).lastFrame(),
    );
    expect(out).toContain("已超时");
  });

  it("tells an empty account how to start", () => {
    const out = plain(
      render(<Dashboard rows={[]} selectedIndex={0} loading={false} />).lastFrame(),
    );
    expect(out).toContain("没有实例");
  });
});

describe("column alignment", () => {
  /** Display column at which `token` begins, counting CJK as two. */
  function columnOf(line: string, token: string): number {
    const index = line.indexOf(token);
    if (index < 0) return -1;
    return stringWidth(line.slice(0, index));
  }

  const NAMES = [
    "short",
    "这是一个非常非常长的中文实例名字会超出列宽",
    "a-very-long-english-instance-name-overflowing",
    "混合mixed名字abc",
    "",
  ];

  function dataLines(selectedIndex: number): string[] {
    const rows = NAMES.map((name, index) =>
      row({ instance: { ...row().instance, uuid: `pro-${index}`, name } }),
    );
    return plain(
      render(<Dashboard rows={rows} selectedIndex={selectedIndex} loading={false} />).lastFrame(),
    )
      .split("\n")
      .filter((line) => line.includes("running"));
  }

  it("starts every later column at the same place however long the name is", () => {
    // The renderer used to paint the full text while padding by the clipped width, so
    // a single long name shoved every column after it out of line.
    const lines = dataLines(-1);
    expect(lines).toHaveLength(NAMES.length);

    for (const token of ["running", "4090D", "北京B区", "≈¥1.97", "10m"]) {
      const columns = lines.map((line) => columnOf(line, token));
      expect(new Set(columns).size, `${token} at ${columns.join(",")}`).toBe(1);
      expect(columns[0]).toBeGreaterThan(0);
    }
  });

  it("keeps alignment when a row is selected", () => {
    const lines = dataLines(2);
    const columns = lines.map((line) => columnOf(line, "running"));
    expect(new Set(columns).size).toBe(1);
  });

  it("truncates an overlong name rather than letting it overflow", () => {
    const long = row({ instance: { ...row().instance, name: "x".repeat(60) } });
    const out = plain(
      render(<Dashboard rows={[long]} selectedIndex={0} loading={false} />).lastFrame(),
    );
    expect(out).toContain("…");
    expect(out).not.toContain("x".repeat(40));
  });
});

describe("StatusBar", () => {
  it("sums the hourly rate across running instances", () => {
    const out = plain(
      render(
        <StatusBar rows={[row(), row()]} hints="" error={null} notice={null} lastUpdated={null} />,
      ).lastFrame(),
    );
    expect(out).toContain("2 台运行中");
    expect(out).toContain("¥3.94/时");
  });

  it("says the total is incomplete when a rate is missing", () => {
    // Silently understating the bill would be the worst failure this screen can have.
    const out = plain(
      render(
        <StatusBar
          rows={[row(), row({ priceYuanPerHour: null, estimatedCostYuan: null })]}
          hints=""
          error={null}
          notice={null}
          lastUpdated={null}
        />,
      ).lastFrame(),
    );
    expect(out).toContain("总额偏低");
  });

  it("states plainly when nothing is costing money", () => {
    const stopped = row({ instance: { ...row().instance, status: "shutdown" } });
    const out = plain(
      render(
        <StatusBar rows={[stopped]} hints="" error={null} notice={null} lastUpdated={null} />,
      ).lastFrame(),
    );
    expect(out).toContain("不产生费用");
  });

  it("keeps errors visible alongside the data", () => {
    const out = plain(
      render(
        <StatusBar rows={[row()]} hints="" error="网络超时" notice={null} lastUpdated={null} />,
      ).lastFrame(),
    );
    expect(out).toContain("网络超时");
    // The summary survives — a dashboard that blanks on a blip is worse than a
    // slightly stale one.
    expect(out).toContain("运行中");
  });
});

describe("Confirm", () => {
  it("defaults to cancel so a stray Enter cannot release an instance", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { stdin } = render(
      <Confirm title="释放？" danger="不可逆" onConfirm={onConfirm} onCancel={onCancel} />,
    );
    stdin.write(ENTER);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it("confirms on an explicit y", () => {
    const onConfirm = vi.fn();
    const { stdin } = render(<Confirm title="释放？" onConfirm={onConfirm} onCancel={vi.fn()} />);
    stdin.write("y");
    expect(onConfirm).toHaveBeenCalled();
  });

  it("surfaces the irreversibility warning", () => {
    const out = plain(
      render(
        <Confirm title="释放？" danger="数据将被永久清空" onConfirm={vi.fn()} onCancel={vi.fn()} />,
      ).lastFrame(),
    );
    expect(out).toContain("数据将被永久清空");
  });
});

describe("stock rows", () => {
  const snapshots = [
    {
      regionId: "chongqingDC1",
      regionName: "重庆A区",
      entries: [{ gpuName: "RTX 4090D", idle: 690, total: 1984, chipCorp: null, cpuArch: null }],
    },
    {
      regionId: "beijingDC2",
      regionName: "北京B区",
      entries: [
        { gpuName: "RTX 5090", idle: 579, total: 2528, chipCorp: null, cpuArch: null },
        { gpuName: "RTX 4090", idle: 346, total: 1344, chipCorp: null, cpuArch: null },
      ],
    },
  ];

  it("sorts by idle count and marks Pro-creatable regions", () => {
    const rows = toStockRows(snapshots, false);
    expect(rows.map((r) => r.idle)).toEqual([690, 579, 346]);
    // Only westDC3 / beijingDC2 accept a Pro instance; the rest are ESD-only.
    expect(rows.find((r) => r.regionId === "chongqingDC1")?.proCreate).toBe(false);
    expect(rows.find((r) => r.regionId === "beijingDC2")?.proCreate).toBe(true);
  });

  it("marks cards the open API cannot rent", () => {
    const rows = toStockRows(snapshots, false);
    // The physical RTX 4090 is not rentable through the open API; only the vGPU
    // partitions are, so conflating them would send users after the wrong card.
    expect(rows.find((r) => r.gpuName === "RTX 4090")?.gpuSpec).toBeNull();
    expect(rows.find((r) => r.gpuName === "RTX 4090D")?.gpuSpec).toBe("4090D");
  });

  it("hides sold-out rows unless asked for them", () => {
    const empty = [
      {
        regionId: "westDC3",
        regionName: "西北B区",
        entries: [{ gpuName: "H800", idle: 0, total: 96, chipCorp: null, cpuArch: null }],
      },
    ];
    expect(toStockRows(empty, false)).toHaveLength(0);
    expect(toStockRows(empty, true)).toHaveLength(1);
  });
});

describe("create wizard", () => {
  it("prints an equivalent CLI command, so the wizard teaches what it replaces", () => {
    const spec = GPU_SPECS.find((s) => s.id === "4090D");
    if (!spec) throw new Error("catalogue is missing 4090D");
    expect(equivalentCommand({ spec, imageUuid: "base-image-l2t43iu6uk", ttlSeconds: 7200 })).toBe(
      "autodl create --gpu 4090D --ttl 2h --wait",
    );
  });

  it("names a non-default image explicitly", () => {
    const spec = GPU_SPECS.find((s) => s.id === "h800");
    if (!spec) throw new Error("catalogue is missing h800");
    expect(equivalentCommand({ spec, imageUuid: "base-image-other", ttlSeconds: 1800 })).toContain(
      "--image base-image-other",
    );
  });
});

describe("Header account panel", () => {
  const identity = { uid: 785976, uuid: "3c9c106f", tenant: "autodl" };
  const balance = { balanceYuan: 404.87, accumulatedYuan: 95.13, voucherYuan: 12.5 };

  it("shows the account id and balance", () => {
    const out = plain(
      render(
        <Header
          subtitle="实例看板"
          identity={identity}
          balance={balance}
          balanceError={null}
          columns={100}
        />,
      ).lastFrame(),
    );
    expect(out).toContain("785976");
    expect(out).toContain("¥404.87");
    expect(out).toContain("¥95.13");
  });

  it("shows vouchers only when there are any", () => {
    const withVoucher = plain(
      render(
        <Header
          subtitle="x"
          identity={identity}
          balance={balance}
          balanceError={null}
          columns={100}
        />,
      ).lastFrame(),
    );
    expect(withVoucher).toContain("¥12.50");

    const without = plain(
      render(
        <Header
          subtitle="x"
          identity={identity}
          balance={{ ...balance, voucherYuan: 0 }}
          balanceError={null}
          columns={100}
        />,
      ).lastFrame(),
    );
    expect(without).not.toContain("+券");
  });

  it("says the balance failed rather than showing a stale or zero figure", () => {
    const out = plain(
      render(
        <Header
          subtitle="x"
          identity={identity}
          balance={null}
          balanceError="网络超时"
          columns={100}
        />,
      ).lastFrame(),
    );
    expect(out).toContain("余额获取失败");
    expect(out).not.toContain("¥0.00");
  });

  it("falls back to a compact header on a narrow terminal", () => {
    const out = plain(
      render(
        <Header
          subtitle="实例看板"
          identity={identity}
          balance={balance}
          balanceError={null}
          columns={50}
        />,
      ).lastFrame(),
    );
    // Plain wordmark, no pixel art, but the balance still gets through.
    expect(out).toContain("AutoDL");
    expect(out).not.toContain("███");
    expect(out).toContain("¥404.87");
  });

  it("shows a dash when the token carries no account id", () => {
    const out = plain(
      render(
        <Header
          subtitle="x"
          identity={{ uid: null, uuid: null, tenant: null }}
          balance={balance}
          balanceError={null}
          columns={100}
        />,
      ).lastFrame(),
    );
    expect(out).toContain("账号 —");
  });
});
