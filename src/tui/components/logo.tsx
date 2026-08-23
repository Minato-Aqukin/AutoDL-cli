import { Box, Text, useStdout } from "ink";
import type React from "react";
import { VERSION } from "../../version.js";

/**
 * The wordmark shown above every screen.
 *
 * Drawn with half-block characters, which every modern terminal renders at single
 * width — unlike box-drawing art, this stays aligned in CJK-configured terminals where
 * ambiguous-width glyphs are doubled.
 */
const BANNER = ["▄▀█ █ █ ▀█▀ █▀█ █▀▄ █", "█▀█ █▄█  █  █▄█ █▄▀ █▄▄"];

/** Below this the banner would wrap and look worse than plain text. */
const MIN_COLUMNS = 46;

interface LogoProps {
  /** Current screen, shown beside the wordmark. */
  subtitle: string;
}

export function Logo({ subtitle }: LogoProps): React.ReactElement {
  const { stdout } = useStdout();
  // `||` rather than `??`: some terminals (and pty wrappers) report 0 columns, and
  // nullish coalescing would let that through as a genuine width.
  const columns = stdout?.columns || 80;

  if (columns < MIN_COLUMNS) {
    return (
      <Box paddingX={1}>
        <Text bold color="cyan">
          AutoDL
        </Text>
        <Text dimColor> · {subtitle}</Text>
      </Box>
    );
  }

  return (
    <Box paddingX={1}>
      <Box flexDirection="column">
        {BANNER.map((line) => (
          <Text key={line} color="cyan" bold>
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginLeft={2} justifyContent="flex-end">
        <Text dimColor>v{VERSION} · 非官方</Text>
        <Text>{subtitle}</Text>
      </Box>
    </Box>
  );
}
