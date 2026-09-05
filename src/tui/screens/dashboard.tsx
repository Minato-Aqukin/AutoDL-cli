import { Box, Text } from "ink";
import type React from "react";
import { formatDuration } from "../../core/duration.js";
import { formatRate, formatYuan } from "../../core/money.js";
import type { Balance, InstanceSnapshot } from "../../core/schemas.js";
import { formatBytes } from "../../output/format.js";
import { headerRows } from "../components/header.js";
import { Gauge, LABEL_WIDTH, READING_WIDTH, Sparkline } from "../components/meters.js";
import { Panel } from "../components/panel.js";
import { type Column, clip, Table } from "../components/table.js";
import type { DashboardRow, UsageHistory } from "../data.js";

/**
 * The dashboard, laid out as widgets rather than one flat table.
 *
 * Modelled on `btm`: the list says what exists, and the panels under it answer the two
 * questions the list cannot — what is this instance actually doing, and what is it
 * costing. Both are about the *selected* instance, because AutoDL only exposes usage and
 * price through a running instance's own snapshot; fetching all of them every poll would
 * be N requests for figures the screen has no room to show anyway.
 */

/** Same status palette as the CLI's `colorStatus`, so both surfaces read alike. */
function statusColor(status: string): string | undefined {
  if (status === "running") return "green";
  if (status === "starting" || status === "creating") return "cyan";
  if (status === "failed" || status === "released") return "red";
  return undefined;
}

function ttlText(row: DashboardRow): string {
  if (row.ttlRemainingMs === null) return "—";
  if (row.ttlRemainingMs <= 0) return "已超时";
  return formatDuration(Math.round(row.ttlRemainingMs / 1000));
}

/**
 * Cost cell.
 *
 * Blank for anything not running: AutoDL only exposes a rate through a running
 * instance's snapshot, so a stopped instance's spend is genuinely unknown here.
 * Showing a plausible-looking number would be worse than showing nothing.
 */
function costText(row: DashboardRow): string {
  if (row.instance.status !== "running") return "—";
  if (row.estimatedCostYuan === null) return "…";
  return `≈${formatYuan(row.estimatedCostYuan)}`;
}

const ALL_COLUMNS: Column<DashboardRow>[] = [
  {
    header: "实例",
    width: 20,
    text: (row) => row.instance.name || row.instance.uuid,
  },
  {
    header: "状态",
    width: 12,
    text: (row) => row.instance.status,
    render: (row, clipped) => <Text color={statusColor(row.instance.status)}>{clipped}</Text>,
  },
  {
    header: "GPU",
    width: 14,
    text: (row) => `${row.instance.gpuSpec ?? "-"}×${row.instance.gpuNum}`,
  },
  {
    header: "地区",
    width: 10,
    text: (row) => row.instance.regionName ?? row.instance.regionSign ?? "-",
  },
  {
    header: "已开机",
    width: 9,
    text: (row) => (row.uptimeSeconds === null ? "—" : formatDuration(row.uptimeSeconds)),
  },
  {
    header: "估算费用",
    width: 10,
    text: costText,
    render: (row, clipped) => (
      <Text color={row.instance.status === "running" ? "yellow" : undefined}>{clipped}</Text>
    ),
  },
  {
    header: "TTL",
    width: 8,
    text: ttlText,
    // Red once overdue: that is money leaking right now.
    render: (row, clipped) =>
      row.ttlRemainingMs !== null && row.ttlRemainingMs <= 0 ? (
        <Text color="red">{clipped}</Text>
      ) : (
        <Text>{clipped}</Text>
      ),
  },
];

/**
 * Columns given up, in order, when the terminal is too narrow for all of them.
 *
 * What an instance *is* (name, status) and what it is *costing* (估算费用, TTL) stay to
 * the end; where it happens to be scheduled is the first thing anyone can do without.
 */
const OPTIONAL_COLUMNS = ["地区", "GPU", "已开机"];

/**
 * A row is the sum of its columns' widths plus a space after each, the cursor cell and
 * the panel's own padding. Overshoot that and Ink does not truncate the row — it wraps
 * it onto a second line, turning the list into double-spaced fragments.
 */
const rowWidth = (columns: Column<DashboardRow>[]): number =>
  3 + columns.length + columns.reduce((sum, column) => sum + column.width, 0);

function columnsFor(width: number): Column<DashboardRow>[] {
  let columns = ALL_COLUMNS;
  for (const header of OPTIONAL_COLUMNS) {
    if (rowWidth(columns) <= width) break;
    columns = columns.filter((column) => column.header !== header);
  }
  return columns;
}

/**
 * Rows the chrome around the list takes.
 *
 * Estimated rather than measured: Ink gives a child no way to learn the height it was
 * handed. Being a row conservative costs one row of the list; being a row optimistic
 * costs the bottom of the frame, which Ink drops without a word.
 */
const STATUS_ROWS = 4;
const PANEL_CHROME = 3;
const METRIC_ROWS = 6;
/** A panel's border plus its horizontal padding. */
const PANEL_PADDING = 4;
/** Space between the CPU reading and its sparkline. */
const SPARK_GAP = 2;
/** Widest instance name a panel's border will carry. */
const NOTE_WIDTH = 24;
/** Below this there is no room for panels *and* a usable list; the list wins. */
const MIN_HEIGHT_FOR_METRICS = 22;
/** Below this the two panels cannot sit side by side without squeezing the bars out. */
const MIN_WIDTH_FOR_COLUMNS = 88;

const percentOf = (used: number | null, total: number | null): number | null =>
  used === null || total === null || total <= 0 ? null : (used / total) * 100;

const sizeOf = (used: number | null, total: number | null): string | undefined =>
  used === null || total === null || total <= 0
    ? undefined
    : `${formatBytes(used)} / ${formatBytes(total)}`;

/** How long the balance lasts at the fleet's current burn rate. */
function runwayText(balance: Balance | null, ratePerHour: number): string {
  if (ratePerHour <= 0) return "当前不产生费用";
  if (!balance) return "余额加载中…";
  if (balance.balanceYuan <= 0) return "余额已耗尽";
  return `按 ${formatRate(ratePerHour)} 约 ${formatDuration(
    Math.round((balance.balanceYuan / ratePerHour) * 3600),
  )}`;
}

function Resources({
  row,
  snapshot,
  history,
  barWidth,
  trailWidth,
}: {
  row: DashboardRow | undefined;
  snapshot: InstanceSnapshot | undefined;
  history: UsageHistory | undefined;
  barWidth: number;
  trailWidth: number;
}): React.ReactElement {
  if (!row) return <Text dimColor>没有选中的实例。</Text>;
  if (row.instance.status !== "running") {
    return <Text dimColor>实例未运行，AutoDL 只对运行中的实例暴露用量。</Text>;
  }
  if (!snapshot) return <Text dimColor>正在获取用量…</Text>;

  const { usage, disk } = snapshot;
  const systemTotal = disk.systemInitBytes + disk.systemExpandBytes;

  return (
    <>
      <Box>
        <Gauge label="CPU" percent={usage.cpuPercent} width={barWidth} color="cyan" />
        {trailWidth >= 8 ? (
          <Box marginLeft={2}>
            <Sparkline values={history?.cpu ?? []} width={trailWidth} color="cyan" />
          </Box>
        ) : null}
      </Box>
      <Gauge
        label="内存"
        percent={usage.memPercent ?? percentOf(usage.memUsedBytes, usage.memLimitBytes)}
        detail={sizeOf(usage.memUsedBytes, usage.memLimitBytes)}
        width={barWidth}
        color="magenta"
      />
      <Gauge
        label="系统盘"
        percent={percentOf(usage.rootFsUsedBytes, usage.rootFsTotalBytes ?? systemTotal)}
        detail={sizeOf(usage.rootFsUsedBytes, usage.rootFsTotalBytes ?? systemTotal)}
        width={barWidth}
        color="blue"
      />
      <Gauge
        label="数据盘"
        percent={percentOf(usage.dataDiskUsedBytes, usage.dataDiskTotalBytes)}
        detail={sizeOf(usage.dataDiskUsedBytes, usage.dataDiskTotalBytes) ?? "未挂载"}
        width={barWidth}
        color="blue"
      />
    </>
  );
}

function Billing({
  row,
  rows,
  balance,
}: {
  row: DashboardRow | undefined;
  rows: DashboardRow[];
  balance: Balance | null;
}): React.ReactElement {
  const running = rows.filter((entry) => entry.instance.status === "running");
  const fleetRate = running.reduce((sum, entry) => sum + (entry.priceYuanPerHour ?? 0), 0);

  const own = !row
    ? "—"
    : row.instance.status !== "running"
      ? "未运行，不计费"
      : row.priceYuanPerHour === null
        ? "单价获取中…"
        : `${formatRate(row.priceYuanPerHour)}　本次已产生 ${formatYuan(row.estimatedCostYuan ?? 0)}`;

  const ttl = !row
    ? "—"
    : row.ttlRemainingMs === null
      ? "未设置，不会自动关机"
      : row.ttlRemainingMs <= 0
        ? "已超时，仍在计费"
        : `${formatDuration(Math.round(row.ttlRemainingMs / 1000))} 后自动关机`;

  const ttlColor =
    row && (row.ttlRemainingMs === null || row.ttlRemainingMs <= 0)
      ? row.instance.status === "running"
        ? "red"
        : "yellow"
      : undefined;

  return (
    <>
      <Box>
        <Text dimColor>{"本机  "}</Text>
        <Text>{own}</Text>
      </Box>
      <Box>
        <Text dimColor>{"TTL   "}</Text>
        <Text color={ttlColor}>{ttl}</Text>
      </Box>
      <Box>
        <Text dimColor>{"余额  "}</Text>
        {balance ? (
          <Text color="green">{formatYuan(balance.balanceYuan)}</Text>
        ) : (
          <Text dimColor>加载中…</Text>
        )}
      </Box>
      <Box>
        <Text dimColor>{"续航  "}</Text>
        <Text>{runwayText(balance, fleetRate)}</Text>
      </Box>
    </>
  );
}

interface DashboardProps {
  rows: DashboardRow[];
  selectedIndex: number;
  loading: boolean;
  /** Live snapshot of the selected instance, when it is running. */
  snapshot?: InstanceSnapshot | undefined;
  history?: UsageHistory | undefined;
  balance?: Balance | null;
  /** Terminal size, so panels are dropped deliberately rather than squeezed out. */
  width?: number;
  height?: number;
}

export function Dashboard({
  rows,
  selectedIndex,
  loading,
  snapshot,
  history,
  balance = null,
  width = 100,
  height = 30,
}: DashboardProps): React.ReactElement {
  const row = rows[selectedIndex];
  const showMetrics = height >= MIN_HEIGHT_FOR_METRICS;
  const sideBySide = width >= MIN_WIDTH_FOR_COLUMNS;
  const metricRows = showMetrics ? (sideBySide ? METRIC_ROWS : METRIC_ROWS * 2) : 0;

  const estimateNote = rows.some(
    (entry) => entry.instance.status === "running" && entry.estimatedCostYuan === null,
  );

  const rowBudget = Math.max(
    1,
    height - headerRows(width) - STATUS_ROWS - metricRows - PANEL_CHROME - (estimateNote ? 1 : 0),
  );
  // A rule between each pair of rows costs a line per gap, so it is drawn only while
  // every instance still fits with them. The moment a rule would push an instance off
  // the panel, the instances win — a divider is worth less than the row it hides.
  const rules = rows.length > 1 && rows.length * 2 - 1 <= rowBudget;
  const maxRows = rules ? rows.length : rowBudget;

  // Label, bar, reading and the trailing size or sparkline all have to fit one panel's
  // inner width; the bar is what gives when they do not. One column is held back, since
  // a row that exactly fills the width is one rounding error from wrapping.
  const panelInner = (sideBySide ? Math.floor((width - 1) / 2) : width) - PANEL_PADDING;
  const budget = panelInner - 1;
  const fixed = LABEL_WIDTH + READING_WIDTH;
  // Room kept for the trailing size, e.g. `  258MB / 20.0GB`. A rare longer one is
  // truncated by the gauge rather than allowed to widen the row.
  const barWidth = Math.max(6, Math.min(18, budget - fixed - 18));
  const trailWidth = Math.max(0, Math.min(16, budget - fixed - barWidth - SPARK_GAP));

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Panel
        title="实例"
        note={rows.length > 0 ? `${Math.min(selectedIndex + 1, rows.length)}/${rows.length}` : ""}
        accent="cyan"
        flexGrow={1}
      >
        <Table
          columns={columnsFor(width)}
          rows={rows}
          selectedIndex={selectedIndex}
          keyFor={(entry) => entry.instance.uuid}
          emptyMessage={loading ? "正在加载实例…" : "当前账号下没有实例。按 n 新建一台。"}
          maxRows={maxRows}
          rules={rules}
        />
        {estimateNote ? (
          <Box paddingX={1}>
            <Text dimColor>
              费用为估算值：AutoDL 按秒计费且有 ¥0.01 下限，单价需选中运行中的实例后才会拉取。
            </Text>
          </Box>
        ) : null}
      </Panel>

      {showMetrics ? (
        <Box flexDirection={sideBySide ? "row" : "column"} gap={sideBySide ? 1 : 0}>
          <Panel
            title="资源"
            // Clipped: the title sits in the border, so an instance named at length would
            // otherwise draw straight through the panel's top-right corner.
            note={row ? clip(row.instance.name || row.instance.uuid, NOTE_WIDTH) : ""}
            flexGrow={1}
            flexBasis={0}
            minHeight={METRIC_ROWS}
          >
            <Resources
              row={row}
              snapshot={snapshot}
              history={history}
              barWidth={barWidth}
              trailWidth={trailWidth}
            />
          </Panel>
          <Panel title="计费" flexGrow={1} flexBasis={0} minHeight={METRIC_ROWS}>
            <Billing row={row} rows={rows} balance={balance} />
          </Panel>
        </Box>
      ) : null}
    </Box>
  );
}
