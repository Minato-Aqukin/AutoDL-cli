import { Box, Text } from "ink";
import type React from "react";
import { formatYuan } from "../../core/money.js";
import type { Balance } from "../../core/schemas.js";
import { VERSION } from "../../version.js";
import type { TokenIdentity } from "../account.js";

/**
 * The framed header: brand mark, account, balance.
 *
 * Drawn as a pixel font on a blue badge, echoing AutoDL's own white-on-blue mark. Every
 * glyph comes from the Block Elements range, which terminals render at single width —
 * box-drawing and other ambiguous-width characters get doubled in CJK-configured
 * terminals and would tear the alignment apart.
 */

/**
 * The swirl. Only the swirl is drawn: the blue background *is* the badge, so outlining
 * a square here would paint a white box the official mark does not have.
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

const ART_COLUMNS = (ICON[0] as string).length + (WORDMARK[0] as string).length;
/** Below this the art would wrap, which looks worse than plain text. */
const MIN_COLUMNS = ART_COLUMNS + 24;

interface HeaderProps {
  subtitle: string;
  identity: TokenIdentity;
  balance: Balance | null;
  balanceError: string | null;
  columns: number;
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
            identity. Labelling it "账号" rather than inventing a name keeps that honest. */}
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
            {balance.voucherYuan > 0 ? (
              <Text dimColor> +券 {formatYuan(balance.voucherYuan)}</Text>
            ) : null}
          </Text>
          <Text dimColor>累计 {formatYuan(balance.accumulatedYuan)}</Text>
        </>
      ) : (
        <Text dimColor>余额加载中…</Text>
      )}
    </Box>
  );
}

/**
 * Brand mark on its own, for surfaces with no account to show — the login screen has
 * no token yet, so there is nothing to put in the account panel.
 */
export function BrandMark({
  subtitle,
  columns,
}: {
  subtitle: string;
  columns: number;
}): React.ReactElement {
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

  return (
    <Box borderStyle="round" borderColor="blue" paddingX={1}>
      <Box flexDirection="column">
        {ICON.map((line, index) => (
          <Text key={line} color="white" backgroundColor="blue">
            {line + (WORDMARK[index] as string)}
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
        <Text bold color="blue">
          AutoDL
          <Text dimColor> · {subtitle}</Text>
        </Text>
        <Text>
          {balance ? (
            <Text color="green">{formatYuan(balance.balanceYuan)}</Text>
          ) : (
            <Text dimColor>—</Text>
          )}
        </Text>
      </Box>
    );
  }

  const art = ICON.map((line, index) => line + (WORDMARK[index] as string));

  return (
    <Box borderStyle="round" borderColor="blue" paddingX={1} justifyContent="space-between">
      <Box>
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
      <Box marginLeft={2} justifyContent="flex-end" flexDirection="column">
        <AccountPanel identity={identity} balance={balance} balanceError={balanceError} />
      </Box>
    </Box>
  );
}
