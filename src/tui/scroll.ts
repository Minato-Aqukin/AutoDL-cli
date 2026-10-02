/**
 * First index of a `rows`-tall window over `total` items that keeps `index` centred.
 *
 * Every scrolling list in the TUI windows this way, so the cursor sits mid-list with
 * context on both sides. Near either end the window stops at the edge and the cursor
 * moves off centre instead, so a list never pads itself with blank rows.
 */
export function centeredStart(index: number, total: number, rows: number): number {
  const visible = Math.max(0, Math.min(rows, total));
  return Math.max(0, Math.min(index - Math.floor((visible - 1) / 2), total - visible));
}
