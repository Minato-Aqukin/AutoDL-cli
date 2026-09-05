import { Box, Text } from "ink";
import type React from "react";
import { formatYuan } from "../../core/money.js";
import type { Balance } from "../../core/schemas.js";
import { VERSION } from "../../version.js";
import type { TokenIdentity } from "../account.js";

/**
 * The framed header: wordmark, account, balance.
 *
 * The wordmark is block art. Note that `█`, `╗` and the rest all carry East Asian Width
 * "Ambiguous", so a terminal configured to draw ambiguous characters double-width will
 * render this at roughly twice its nominal columns. That is a deliberate trade for the
 * look; the compact fallback below covers terminals too narrow to take it.
 */

export const WORDMARK = [
  "  █████╗  ██╗   ██╗ ████████╗  ██████╗  ██████╗  ██╗     ",
  " ██╔══██╗ ██║   ██║ ╚══██╔══╝ ██╔═══██╗ ██╔══██╗ ██║     ",
  " ███████║ ██║   ██║    ██║    ██║   ██║ ██║  ██║ ██║     ",
  " ██╔══██║ ██║   ██║    ██║    ██║   ██║ ██║  ██║ ██║     ",
  " ██║  ██║ ╚██████╔╝    ██║    ╚██████╔╝ ██████╔╝ ███████╗",
  " ╚═╝  ╚═╝  ╚═════╝     ╚═╝     ╚═════╝  ╚═════╝  ╚══════╝",
];

/**
 * White at the top fading to AutoDL's blue at the bottom, one step per row.
 *
 * Written as hex so chalk emits truecolor where the terminal supports it and degrades
 * to the nearest 256- or 16-colour match elsewhere, rather than us guessing.
 */
export const ROW_COLORS = ["#FFFFFF", "#D5E1FD", "#AAC4FB", "#80A6F9", "#5589F7", "#2B6BF5"];

/** AutoDL's blue, reused for the frame and the compact fallback. */
const BRAND_BLUE = "#2B6BF5";

const ART_COLUMNS = (WORDMARK[0] as string).length;
/** Art plus the account column plus the frame. Below this, fall back to one line. */
export const MIN_COLUMNS = ART_COLUMNS + 21;

/** Rows the header occupies, so the dashboard can budget the space it is left. */
export const headerRows = (columns: number): number =>
  columns < MIN_COLUMNS ? 3 : WORDMARK.length + 2;

interface HeaderProps {
  subtitle: string;
  identity: TokenIdentity;
  balance: Balance | null;
  balanceError: string | null;
  columns: number;
}

function Wordmark(): React.ReactElement {
  return (
    <Box flexDirection="column">
      {WORDMARK.map((line, index) => (
        <Text key={line} color={ROW_COLORS[index]}>
          {line}
        </Text>
      ))}
    </Box>
  );
}

function AccountPanel({
  identity,
  balance,
  balanceError,
}: Pick<HeaderProps, "identity" | "balance" | "balanceError">): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>账号 </Text>
        {/* AutoDL's open API exposes no display name, so the uid from the token is the
            identity. Labelling it 账号 rather than inventing a name keeps that honest. */}
        <Text bold>{identity.uid ?? "—"}</Text>
      </Text>
      {balanceError ? (
        <Text color="red">余额获取失败</Text>
      ) : balance ? (
        <>
          <Text>
            <Text dimColor>余额 </Text>
            <Text bold color="green">
              {formatYuan(balance.balanceYuan)}
            </Text>
          </Text>
          {balance.voucherYuan > 0 ? (
            <Text dimColor>券 {formatYuan(balance.voucherYuan)}</Text>
          ) : null}
          <Text dimColor>累计 {formatYuan(balance.accumulatedYuan)}</Text>
        </>
      ) : (
        <Text dimColor>余额加载中…</Text>
      )}
    </Box>
  );
}

/** The gradient wordmark on its own, for surfaces with no account to show. */
export function BrandMark({
  subtitle,
  columns,
}: {
  subtitle: string;
  columns: number;
}): React.ReactElement {
  if (columns < ART_COLUMNS + 4) {
    return (
      <Box borderStyle="round" borderColor="blue" paddingX={1}>
        <Text bold color={BRAND_BLUE}>
          AutoDL
        </Text>
        <Text dimColor> · {subtitle}</Text>
      </Box>
    );
  }

  return (
    <Box borderStyle="round" borderColor="blue" paddingX={1} flexDirection="column">
      <Wordmark />
      <Text dimColor>
        v{VERSION} · 非官方 · {subtitle}
      </Text>
    </Box>
  );
}

export function Header({
  subtitle,
  identity,
  balance,
  balanceError,
  columns,
}: HeaderProps): React.ReactElement {
  if (columns < MIN_COLUMNS) {
    return (
      <Box borderStyle="round" borderColor="blue" paddingX={1} justifyContent="space-between">
        <Text bold color={BRAND_BLUE}>
          AutoDL
          <Text dimColor> · {subtitle}</Text>
        </Text>
        {balance ? (
          <Text color="green">{formatYuan(balance.balanceYuan)}</Text>
        ) : (
          <Text dimColor>—</Text>
        )}
      </Box>
    );
  }

  return (
    <Box borderStyle="round" borderColor="blue" paddingX={1} justifyContent="space-between">
      <Wordmark />
      <Box flexDirection="column" marginLeft={2} justifyContent="space-between">
        <AccountPanel identity={identity} balance={balance} balanceError={balanceError} />
        <Text dimColor>
          v{VERSION} · {subtitle}
        </Text>
      </Box>
    </Box>
  );
}
