import { Box, Text } from "ink";
import type React from "react";
import { formatDuration } from "../../core/duration.js";
import { formatYuan } from "../../core/money.js";
import { type Column, Table } from "../components/table.js";
import type { DashboardRow } from "../data.js";

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

const columns: Column<DashboardRow>[] = [
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

interface DashboardProps {
  rows: DashboardRow[];
  selectedIndex: number;
  loading: boolean;
}

export function Dashboard({ rows, selectedIndex, loading }: DashboardProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Table
        columns={columns}
        rows={rows}
        selectedIndex={selectedIndex}
        keyFor={(row) => row.instance.uuid}
        emptyMessage={loading ? "正在加载实例…" : "当前账号下没有实例。按 n 新建一台。"}
      />
      {rows.some((row) => row.instance.status === "running" && row.estimatedCostYuan === null) ? (
        <Box paddingX={1}>
          <Text dimColor>
            费用为估算值：AutoDL 按秒计费且有 ¥0.01 下限，单价需选中运行中的实例后才会拉取。
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
