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
function clip(value: string, width: number): string {
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
}

export function Table<T>({
  columns,
  rows,
  selectedIndex,
  keyFor,
  emptyMessage,
}: TableProps<T>): React.ReactElement {
  if (rows.length === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>{emptyMessage}</Text>
      </Box>
    );
  }

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
      {rows.map((row, index) => {
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
