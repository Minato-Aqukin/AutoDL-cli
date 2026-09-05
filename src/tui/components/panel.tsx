import { Box, Text } from "ink";
import type React from "react";

/**
 * A bordered widget with its title set into the top border.
 *
 * The title is absolutely positioned over the border rather than given a row inside it.
 * On a 24-row terminal every line the chrome eats is a line of data, and three stacked
 * panels each spending a row on their own name costs more than all three borders do.
 */

interface PanelProps {
  title: string;
  /** Dimmed text after the title — a count, a unit, which instance this is about. */
  note?: string;
  /** Border and title colour. Undefined leaves the terminal's default. */
  accent?: string;
  flexGrow?: number;
  /** Paired with flexGrow to make siblings share a row evenly regardless of content. */
  flexBasis?: number;
  minHeight?: number;
  children: React.ReactNode;
}

export function Panel({
  title,
  note,
  accent,
  flexGrow,
  flexBasis,
  minHeight,
  children,
}: PanelProps): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={accent}
      paddingX={1}
      flexGrow={flexGrow}
      flexBasis={flexBasis}
      minHeight={minHeight}
    >
      {/* Out of flow, so it costs no row and cannot push the content down. Note that the
          panel must not clip its overflow: the title sits a row *above* the content box,
          and `overflow: hidden` here erases it rather than the border showing through. */}
      <Box position="absolute" marginLeft={1} marginTop={-1}>
        <Text bold color={accent}>{` ${title} `}</Text>
        {note ? <Text dimColor>{`${note} `}</Text> : null}
      </Box>
      {children}
    </Box>
  );
}
