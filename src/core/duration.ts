import { UsageError } from "./errors.js";

const PATTERN = /^(\d+(?:\.\d+)?)(s|m|h|d)?$/i;

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

/**
 * Parse a human duration like `30m`, `2h`, `1.5h`, `90` (bare = minutes).
 * Used by `--ttl`, `--timeout` and the idle guard.
 */
export function parseDuration(input: string, { bareUnit = "m" } = {}): number {
  const match = PATTERN.exec(input.trim());
  if (!match) {
    throw new UsageError(`无法解析时长 "${input}"`, {
      hint: "支持的格式：30s、45m、2h、1d，或纯数字（默认按分钟）",
    });
  }
  const value = Number(match[1]);
  const unit = (match[2] ?? bareUnit).toLowerCase();
  const factor = UNIT_SECONDS[unit];
  if (factor === undefined) {
    throw new UsageError(`不支持的时长单位 "${unit}"`, { hint: "支持 s / m / h / d" });
  }
  const seconds = Math.round(value * factor);
  if (seconds <= 0) {
    throw new UsageError(`时长必须大于 0，收到 "${input}"`);
  }
  return seconds;
}

/** Seconds -> compact human string, e.g. `2h30m`. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return parts.join("") || `${seconds}s`;
}
