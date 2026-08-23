import { Box, Text } from "ink";
import type React from "react";
import { formatDuration } from "../../core/duration.js";
import { formatRate } from "../../core/money.js";
import type { InstanceSnapshot } from "../../core/schemas.js";
import { formatBytes, formatTime } from "../../output/format.js";
import type { DashboardRow } from "../data.js";

interface DetailProps {
  row: DashboardRow;
  snapshot: InstanceSnapshot | undefined;
  /** Passwords stay masked until explicitly revealed, as in `autodl info`. */
  revealSecrets: boolean;
}

function Field({ label, value }: { label: string; value: React.ReactNode }): React.ReactElement {
  return (
    <Box>
      <Box width={12}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  );
}

export function Detail({ row, snapshot, revealSecrets }: DetailProps): React.ReactElement {
  const { instance } = row;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{instance.name || instance.uuid}</Text>
      <Field label="实例 ID" value={instance.uuid} />
      <Field label="状态" value={instance.status} />
      <Field label="GPU" value={`${instance.gpuSpec ?? "-"} ×${instance.gpuNum}`} />
      <Field label="地区" value={instance.regionName ?? instance.regionSign ?? "-"} />
      <Field label="计费" value={instance.chargeType ?? "-"} />
      <Field label="创建" value={formatTime(instance.createdAt)} />
      <Field label="开机" value={formatTime(instance.startedAt)} />
      {row.uptimeSeconds !== null ? (
        <Field label="已开机" value={formatDuration(row.uptimeSeconds)} />
      ) : null}

      {instance.status !== "running" ? (
        <Box marginTop={1}>
          <Text dimColor>实例未运行，SSH 信息与单价需开机后才能获取。</Text>
        </Box>
      ) : !snapshot ? (
        <Box marginTop={1}>
          <Text dimColor>正在获取 SSH 信息…</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Field
            label="单价"
            value={snapshot.priceYuanPerHour ? formatRate(snapshot.priceYuanPerHour) : "-"}
          />
          <Field label="SSH" value={snapshot.ssh.command ?? "-"} />
          <Field
            label="密码"
            value={
              revealSecrets ? (
                (snapshot.ssh.password ?? "-")
              ) : (
                <Text dimColor>*** （按 p 显示）</Text>
              )
            }
          />
          {snapshot.usage.cpuPercent !== null ? (
            <Field label="CPU" value={`${snapshot.usage.cpuPercent.toFixed(1)}%`} />
          ) : null}
          {snapshot.usage.memUsedBytes !== null ? (
            <Field
              label="内存"
              value={`${formatBytes(snapshot.usage.memUsedBytes)} / ${formatBytes(snapshot.usage.memLimitBytes)}`}
            />
          ) : null}
          {snapshot.services.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>自定义服务</Text>
              {snapshot.services.map((service) => (
                <Text key={service.port}>
                  {"  "}
                  {service.port} → {service.domain}
                </Text>
              ))}
            </Box>
          ) : null}
        </Box>
      )}
    </Box>
  );
}
