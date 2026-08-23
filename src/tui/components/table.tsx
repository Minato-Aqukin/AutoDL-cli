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
  /** Rendered cell. Returning a React node allows per-cell colouring. */
  render: (row: T) => React.ReactNode;
  /** Plain text of the same cell, used for width accounting. */
  text: (row: T) => string;
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
              const raw = clip(column.text(row), column.width);
              return (
                <Text key={column.header} inverse={selected}>
                  {column.render(row)}
                  {pad(raw, column.width)}{" "}
                </Text>
              );
            })}
          </Box>
        );
      })}
    </Box>
  );
}
