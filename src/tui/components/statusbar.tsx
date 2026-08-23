import { Box, Text } from "ink";
import type React from "react";
import { formatYuan } from "../../core/money.js";
import type { DashboardRow } from "../data.js";

interface StatusBarProps {
  rows: DashboardRow[];
  hints: string;
  error: string | null;
  notice: string | null;
  lastUpdated: number | null;
}

/**
 * Bottom bar: what is costing money right now, plus keys and the latest message.
 *
 * The running total is the reason the dashboard exists — AutoDL bills on power state,
 * so "two instances up, ¥3.94/hr" is the number that changes behaviour.
 */
export function StatusBar({
  rows,
  hints,
  error,
  notice,
  lastUpdated,
}: StatusBarProps): React.ReactElement {
  const running = rows.filter((row) => row.instance.status === "running");
  const ratePerHour = running.reduce((sum, row) => sum + (row.priceYuanPerHour ?? 0), 0);
  const accrued = running.reduce((sum, row) => sum + (row.estimatedCostYuan ?? 0), 0);
  // Rates come from per-instance snapshots, which are fetched lazily; say so rather
  // than quietly under-reporting the total.
  const partial = running.some((row) => row.priceYuanPerHour === null);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        {running.length > 0 ? (
          <Text>
            <Text color="green">● {running.length} 台运行中</Text>
            <Text dimColor> · </Text>
            <Text>
              {ratePerHour > 0 ? `${formatYuan(ratePerHour)}/时` : "单价获取中"}
              {accrued > 0 ? ` · 本次已产生约 ${formatYuan(accrued)}` : ""}
            </Text>
            {partial ? <Text dimColor> （部分实例单价未取到，总额偏低）</Text> : null}
          </Text>
        ) : (
          <Text dimColor>○ 没有运行中的实例，当前不产生费用</Text>
        )}
        {lastUpdated ? (
          <Text dimColor>
            {"  "}
            {new Date(lastUpdated).toLocaleTimeString()} 刷新
          </Text>
        ) : null}
      </Box>
      {error ? <Text color="red">✖ {error}</Text> : null}
      {notice ? <Text color="cyan">{notice}</Text> : null}
      <Text dimColor>{hints}</Text>
    </Box>
  );
}
