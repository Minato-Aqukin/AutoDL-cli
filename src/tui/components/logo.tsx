import { Box, Text, useStdout } from "ink";
import type React from "react";
import { VERSION } from "../../version.js";

/**
 * The wordmark shown above every screen.
 *
 * Drawn as a pixel font on a blue badge, echoing AutoDL's own white-on-blue mark. Every
 * glyph comes from the Block Elements range, which terminals render at single width —
 * unlike box-drawing or ambiguous-width art, this stays aligned in CJK-configured
 * terminals where such characters get doubled.
 *
 * All lines in a block are padded to equal length so the background colour forms a
 * clean rectangle rather than a ragged one.
 */

/**
 * The swirl, echoing AutoDL's own mark.
 *
 * Only the swirl is drawn: the blue background *is* the badge, so outlining a square
 * here would paint a white box the official mark does not have.
 */
const ICON = ["  ▄▄▄  ", " ▟▀▀▀▘ ", " ▙▄▄▖  ", " ▝▀▀▜▌ ", "  ▀▀▀  "];

/** AUTODL on a 5-pixel grid, one terminal cell per pixel. */
const WORDMARK = [
  " ███  █   █ █████  ███  ████  █     ",
  "█   █ █   █   █   █   █ █   █ █     ",
  "█████ █   █   █   █   █ █   █ █     ",
  "█   █ █   █   █   █   █ █   █ █     ",
  "█   █  ███    █    ███  ████  █████ ",
];

/** Width of the badge plus the wordmark, before the frame and padding. */
const ART_COLUMNS = 7 + 1 + 36;

/** Below this the art would wrap, which looks worse than plain text. */
const MIN_COLUMNS = ART_COLUMNS + 12;

interface LogoProps {
  /** Current screen, shown beside the wordmark. */
  subtitle: string;
}

function padded(lines: string[]): string[] {
  const width = Math.max(...lines.map((line) => line.length));
  return lines.map((line) => line.padEnd(width, " "));
}

export function Logo({ subtitle }: LogoProps): React.ReactElement {
  const { stdout } = useStdout();
  // `||` rather than `??`: some terminals and pty wrappers report 0 columns, and
  // nullish coalescing would let that through as a genuine width.
  const columns = stdout?.columns || 80;

  if (columns < MIN_COLUMNS) {
    return (
      <Box borderStyle="round" borderColor="blue" paddingX={1}>
        <Text bold color="blue">
          AutoDL
        </Text>
        <Text dimColor> · {subtitle}</Text>
      </Box>
    );
  }

  const art = padded([...ICON.map((line, i) => line + WORDMARK[i])]);

  return (
    <Box borderStyle="round" borderColor="blue" paddingX={1}>
      <Box flexDirection="column">
        {art.map((line) => (
          <Text key={line} color="white" backgroundColor="blue">
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginLeft={2} justifyContent="flex-end">
        <Text dimColor>v{VERSION} · 非官方</Text>
        <Text bold>{subtitle}</Text>
      </Box>
    </Box>
  );
}
