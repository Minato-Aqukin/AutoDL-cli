import { Box, Text } from "ink";
import type React from "react";
import { stringWidth } from "../../output/format.js";
import { headerRows } from "./header.js";
import { PANEL_PADDING, Panel } from "./panel.js";
import { STATUS_ROWS } from "./statusbar.js";
import { type Column, Table } from "./table.js";

/**
 * A list screen framed like the dashboard's instance panel: one table in a panel that
 * fills the frame, the position in its border, and notes pinned to its bottom.
 *
 * The table is capped to the rows the frame has left, so a long list scrolls with the
 * cursor instead of pushing the notes and the status bar out of the frame.
 */

/** The panel's border plus the table's labels and the rule under them. */
const LIST_CHROME = 4;

export interface ListNote {
  text: string;
  /** Unset renders the note dimmed. */
  color?: string;
}

interface ListPanelProps<T> {
  title: string;
  columns: Column<T>[];
  rows: T[];
  selectedIndex: number;
  keyFor: (row: T) => string;
  emptyMessage: string;
  notes: ListNote[];
  /** Terminal size: the header and status bar take their share before the list. */
  width: number;
  height: number;
}

export function ListPanel<T>({
  title,
  columns,
  rows,
  selectedIndex,
  keyFor,
  emptyMessage,
  notes,
  width,
  height,
}: ListPanelProps<T>): React.ReactElement {
  // Notes wrap like any other text; each takes the rows it wraps to, plus one margin row.
  const inner = Math.max(1, width - PANEL_PADDING - 2);
  const noteRows = notes.reduce(
    (sum, note) => sum + Math.max(1, Math.ceil(stringWidth(note.text) / inner)),
    notes.length > 0 ? 1 : 0,
  );
  const maxRows = Math.max(1, height - headerRows(width) - STATUS_ROWS - LIST_CHROME - noteRows);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Panel
        title={title}
        note={rows.length > 0 ? `${Math.min(selectedIndex + 1, rows.length)}/${rows.length}` : ""}
        accent="cyan"
        flexGrow={1}
      >
        <Table
          columns={columns}
          rows={rows}
          selectedIndex={selectedIndex}
          keyFor={keyFor}
          emptyMessage={emptyMessage}
          maxRows={maxRows}
        />
        <Box flexGrow={1} />
        {notes.length > 0 ? (
          <Box flexDirection="column" paddingX={1} marginTop={1}>
            {notes.map((note) => (
              <Text key={note.text} color={note.color} dimColor={!note.color}>
                {note.text}
              </Text>
            ))}
          </Box>
        ) : null}
      </Panel>
    </Box>
  );
}
