import { Box, Text } from "ink";
import type React from "react";
import { GPU_SPECS, PRO_CREATE_REGIONS } from "../../core/catalog.js";
import type { StockSnapshot } from "../../core/stock.js";
import { type Column, Table } from "../components/table.js";

export interface StockRow {
  regionId: string;
  regionName: string;
  proCreate: boolean;
  gpuName: string;
  gpuSpec: string | null;
  idle: number;
  total: number;
}

/** Flatten per-region snapshots into rows, busiest first. */
export function toStockRows(snapshots: StockSnapshot[], showEmpty: boolean): StockRow[] {
  const rentable = new Map(GPU_SPECS.map((spec) => [spec.stockName, spec.id]));
  const proRegions = new Set(PRO_CREATE_REGIONS.map((region) => region.id));

  return snapshots
    .flatMap((snapshot) =>
      snapshot.entries
        .filter((entry) => showEmpty || entry.idle > 0)
        .map((entry) => ({
          regionId: snapshot.regionId,
          regionName: snapshot.regionName,
          proCreate: proRegions.has(snapshot.regionId),
          gpuName: entry.gpuName,
          gpuSpec: rentable.get(entry.gpuName) ?? null,
          idle: entry.idle,
          total: entry.total,
        })),
    )
    .sort((a, b) => b.idle - a.idle);
}

const columns: Column<StockRow>[] = [
  {
    header: "地区",
    width: 12,
    text: (row) => row.regionName,
    render: (row) => <Text>{row.regionName}</Text>,
  },
  {
    header: "可建Pro",
    width: 8,
    text: (row) => (row.proCreate ? "是" : "否"),
    render: (row) => (row.proCreate ? <Text color="green">是</Text> : <Text dimColor>否</Text>),
  },
  {
    header: "GPU",
    width: 18,
    text: (row) => row.gpuName,
    render: (row) => <Text>{row.gpuName}</Text>,
  },
  {
    header: "可租规格",
    width: 12,
    text: (row) => row.gpuSpec ?? "—",
    render: (row) =>
      row.gpuSpec ? <Text color="green">{row.gpuSpec}</Text> : <Text dimColor>—</Text>,
  },
  {
    header: "空闲",
    width: 7,
    text: (row) => String(row.idle),
    render: (row) => <Text bold={row.idle > 0}>{row.idle}</Text>,
  },
  {
    header: "总数",
    width: 7,
    text: (row) => String(row.total),
    render: (row) => <Text dimColor>{row.total}</Text>,
  },
];

interface StockScreenProps {
  rows: StockRow[];
  selectedIndex: number;
  loading: boolean;
}

export function StockScreen({
  rows,
  selectedIndex,
  loading,
}: StockScreenProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Table
        columns={columns}
        rows={rows}
        selectedIndex={selectedIndex}
        keyFor={(row) => `${row.regionId}:${row.gpuName}`}
        emptyMessage={loading ? "正在查询库存…" : "查询范围内没有空闲 GPU"}
      />
      <Box flexDirection="column" paddingX={1} marginTop={1}>
        <Text dimColor>
          「可建Pro」只有 {PRO_CREATE_REGIONS.map((r) => r.displayName).join(" / ")} 为是，
          其余地区仅用于弹性部署。
        </Text>
        <Text color="yellow">
          数字来自「弹性部署 GPU 库存」，不代表 Pro 实例可用量——实测出现过显示 140
          张空闲、创建却提示暂无库存的情况。
        </Text>
      </Box>
    </Box>
  );
}
