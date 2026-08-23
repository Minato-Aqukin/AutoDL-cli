/**
 * AutoDL expresses every monetary value in "milliyuan" (毫元) — integer thousandths
 * of a CNY. We normalise to plain yuan at the edge of `core/` so nothing above this
 * layer ever has to remember the factor.
 */

const MILLI_PER_YUAN = 1000;

/** Milliyuan integer -> yuan number, rounded to fen (2dp) to avoid float noise. */
export function milliToYuan(milli: number | null | undefined): number {
  if (milli === null || milli === undefined || Number.isNaN(milli)) return 0;
  return Math.round((milli / MILLI_PER_YUAN) * 100) / 100;
}

/** Yuan -> milliyuan integer, for request payloads that take price bounds. */
export function yuanToMilli(yuan: number): number {
  return Math.round(yuan * MILLI_PER_YUAN);
}

/** Human display, e.g. `¥1.97`. */
export function formatYuan(yuan: number): string {
  return `¥${yuan.toFixed(2)}`;
}

/** Human display for a per-hour rate, e.g. `¥1.97/时`. */
export function formatRate(yuanPerHour: number, unit = "时"): string {
  return `${formatYuan(yuanPerHour)}/${unit}`;
}

/**
 * Estimate cost for a duration at a per-hour rate. AutoDL bills per second with a
 * ¥0.01 floor, so this mirrors that rather than rounding up to whole hours.
 */
export function estimateCost(yuanPerHour: number, seconds: number): number {
  const raw = (yuanPerHour * seconds) / 3600;
  if (raw <= 0) return 0;
  return Math.max(0.01, Math.round(raw * 100) / 100);
}
