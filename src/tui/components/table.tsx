import { Box, Text } from "ink";
import type React from "react";
import { stringWidth } from "../../output/format.js";

/**
 * A selectable fixed-width table.
 *
 * Uses the same CJK-aware width measurement as the CLI's tables (`stringWidth` in
 * output/format.ts): Chinese labels occupy two terminal columns, and padding by
 * `.length` misaligns every row.
 */

export interface Column<T> {
  header: string;
  width: number;
  /** The cell's plain text. The table clips it to `width` before anything else. */
  text: (row: T) => string;
  /**
   * Optional styling, given the *already-clipped* text.
   *
   * Renderers must use the string handed to them rather than re-deriving it: padding is
   * computed from the clipped value, so emitting the full text here would overflow the
   * column and shove every later column out of line — which is exactly what a long
   * instance name used to do.
   */
  render?: (row: T, clipped: string) => React.ReactNode;
}

function pad(value: string, width: number): string {
  const spare = width - stringWidth(value);
  return spare > 0 ? " ".repeat(spare) : "";
}

/**
 * The cursor cell every data row opens with.
 *
 * The header has to reserve it too. It did not, so every value in the table sat exactly
 * one column to the right of the label naming it — uniformly, which is what made it read
 * as "the columns are off" rather than as a missing character.
 */
const CURSOR = { marker: "›", blank: " " };

/** Cut to `width` columns, counting CJK as two. */
export function clip(value: string, width: number): string {
  if (stringWidth(value) <= width) return value;
  let out = "";
  for (const char of value) {
    if (stringWidth(out + char) > width - 1) break;
    out += char;
  }
  return `${out}…`;
}

interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  selectedIndex: number;
  keyFor: (row: T) => string;
  emptyMessage: string;
  /**
   * Cap on visible data rows. The window follows the selection.
   *
   * Without it a list longer than the terminal is not truncated but *squeezed out* of
   * the frame from the bottom — Ink neither scrolls nor complains — taking the panels
   * and the key hints below it along too.
   */
  maxRows?: number;
  /**
   * Draw a rule between rows.
   *
   * The caller decides, because each rule costs a row of the list — worth it for the
   * handful of instances most accounts have, not worth it when the choice is between a
   * rule and seeing the instance under it.
   */
  rules?: boolean;
}

/** Content columns a row occupies: the cursor cell plus each column and its gutter. */
export const contentWidth = <T,>(columns: Column<T>[]): number =>
  1 + columns.reduce((sum, column) => sum + column.width + 1, 0);

export function Table<T>({
  columns,
  rows,
  selectedIndex,
  keyFor,
  emptyMessage,
  maxRows,
  rules = false,
}: TableProps<T>): React.ReactElement {
  if (rows.length === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>{emptyMessage}</Text>
      </Box>
    );
  }

  // Centred on the selection where the list allows it, so the row being acted on is
  // always on screen and the rows around it stay stable while the cursor moves.
  const visible = maxRows && maxRows > 0 ? Math.min(maxRows, rows.length) : rows.length;
  const start = Math.max(
    0,
    Math.min(selectedIndex - Math.floor((visible - 1) / 2), rows.length - visible),
  );
  const window = rows.slice(start, start + visible);

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text>{CURSOR.blank}</Text>
        {columns.map((column) => (
          <Text key={column.header} bold>
            {clip(column.header, column.width)}
            {pad(clip(column.header, column.width), column.width)}{" "}
          </Text>
        ))}
      </Box>
      {window.map((row, offset) => {
        const index = start + offset;
        const selected = index === selectedIndex;
        return (
          <Box key={keyFor(row)} flexDirection="column">
            {/* Between rows only, never above the first: a rule under the header would
                read as a second header instead of as a divider. */}
            {rules && offset > 0 ? (
              <Box paddingX={1}>
                <Text dimColor>{"┈".repeat(contentWidth(columns))}</Text>
              </Box>
            ) : null}
            <Box paddingX={1}>
              <Text inverse={selected}>{selected ? CURSOR.marker : CURSOR.blank}</Text>
              {columns.map((column) => {
                const clipped = clip(column.text(row), column.width);
                return (
                  <Text key={column.header} inverse={selected}>
                    {column.render ? column.render(row, clipped) : clipped}
                    {pad(clipped, column.width)}{" "}
                  </Text>
                );
              })}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
