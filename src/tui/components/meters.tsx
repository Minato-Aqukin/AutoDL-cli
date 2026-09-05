import { Box, Text } from "ink";
import type React from "react";
import { stringWidth } from "../../output/format.js";

/**
 * Bars and sparklines, in the spirit of `btm`.
 *
 * Both draw with block-element characters (U+2580–U+259F). Those carry East Asian Width
 * "Ambiguous", exactly like the wordmark's box art, so a terminal configured to draw
 * ambiguous characters double-width renders them twice as wide — the same trade this
 * project already makes for the logo, and `stringWidth` counts them as one column
 * throughout so the arithmetic here matches the table's.
 *
 * The honesty rule from the cost columns applies here too: a missing measurement draws a
 * dash, never an empty bar. An empty bar reads as "measured, and it is zero".
 */

const FILLED = "█";
const EMPTY = "░";
/** Eight rungs, so a sparkline can show a shape rather than just presence. */
const RAMP = "▁▂▃▄▅▆▇█";

/** Clamp into 0–100 so a bad reading cannot draw outside its own bar. */
const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

export function bar(percent: number, width: number): string {
  const clamped = clampPercent(percent);
  // Any reading above zero keeps at least one block. On a ten-wide bar everything under
  // 5% rounds away, and a bar drawn completely empty reads as "idle" rather than "low".
  const filled = clamped > 0 ? Math.max(1, Math.round((clamped / 100) * width)) : 0;
  const shown = Math.min(width, filled);
  return FILLED.repeat(shown) + EMPTY.repeat(width - shown);
}

/**
 * A block sparkline over a fixed 0–100 scale.
 *
 * Fixed rather than auto-scaled to the series' own maximum: auto-scaling draws a flat 2%
 * idle as a full-height mountain range, which is the opposite of informative when the
 * question is "is this thing actually working".
 */
export function sparkline(values: number[], width: number): string {
  const recent = values.slice(-width);
  const drawn = recent
    .map((value) => {
      const rung = Math.floor((clampPercent(value) / 100) * (RAMP.length - 1) + 0.5);
      return RAMP[rung] ?? RAMP[0];
    })
    .join("");
  // Right-aligned: history grows from the right, so the newest sample keeps its place
  // instead of marching across the panel as the window fills.
  return " ".repeat(Math.max(0, width - recent.length)) + drawn;
}

/** Widest label the resource panel uses (`系统盘` is three CJK characters). */
export const LABEL_WIDTH = 6;
/** ` 100.0%` — the reading, right-aligned so the decimal points line up. */
export const READING_WIDTH = 7;

interface GaugeProps {
  label: string;
  /** Null when the figure is genuinely unknown, which draws a dash instead of a bar. */
  percent: number | null;
  /** Right-hand annotation, e.g. `2.1GB / 20.0GB`. */
  detail?: string;
  width: number;
  color?: string;
}

export function Gauge({ label, percent, detail, width, color }: GaugeProps): React.ReactElement {
  // Built as one string rather than adjacent JSX expressions: Ink lays each `<Text>` out
  // separately, and a lone `{" "}` between two of them is not reliably a column of space.
  const head = `${label}${" ".repeat(Math.max(0, LABEL_WIDTH - stringWidth(label)))} `;
  const reading = percent === null ? "—" : `${percent.toFixed(1)}%`;

  return (
    <Box>
      <Text dimColor>{head}</Text>
      {percent === null ? (
        <Text dimColor>{"".padEnd(width, "·")}</Text>
      ) : (
        <Text color={color}>{bar(percent, width)}</Text>
      )}
      <Text>{reading.padStart(READING_WIDTH)}</Text>
      {detail ? (
        // Truncated rather than wrapped: a size that does not fit should lose its tail,
        // not push the next gauge onto a second line and buckle the panel.
        <Text dimColor wrap="truncate">{`  ${detail}`}</Text>
      ) : null}
    </Box>
  );
}

interface SparklineProps {
  values: number[];
  width: number;
  color?: string;
}

export function Sparkline({ values, width, color }: SparklineProps): React.ReactElement {
  if (values.length === 0) {
    return <Text dimColor>{"采样中…".padEnd(width)}</Text>;
  }
  return <Text color={color}>{sparkline(values, width)}</Text>;
}
