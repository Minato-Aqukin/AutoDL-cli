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
}

export function Table<T>({
  columns,
  rows,
  selectedIndex,
  keyFor,
  emptyMessage,
  maxRows,
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
          <Box key={keyFor(row)} paddingX={1}>
            <Text inverse={selected}>{selected ? "›" : " "}</Text>
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
        );
      })}
    </Box>
  );
}
