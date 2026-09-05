import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";

/**
 * Modal confirmation for irreversible actions.
 *
 * Mirrors the CLI's `confirmDestructive`: destructive operations never proceed on a
 * single keystroke. Defaults to "no", so a stray Enter cannot release an instance.
 */

/**
 * The keys this modal answers to.
 *
 * Exported because the status bar has to name them too while the modal is up, and two
 * hand-written copies of a key list drift apart the moment one of them is edited.
 */
export const CONFIRM_KEYS = "←→ 切换 · Enter 确定 · y/n 直接选 · Esc 取消";

interface ConfirmProps {
  title: string;
  detail?: string;
  /** Extra warning shown in red, e.g. that data will be wiped. */
  danger?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function Confirm({
  title,
  detail,
  danger,
  confirmLabel = "确认",
  onConfirm,
  onCancel,
}: ConfirmProps): React.ReactElement {
  const [yes, setYes] = useState(false);

  useInput((input, key) => {
    if (key.leftArrow || key.rightArrow || input === "h" || input === "l" || key.tab) {
      setYes((v) => !v);
      return;
    }
    if (key.return) {
      if (yes) onConfirm();
      else onCancel();
      return;
    }
    if (key.escape || input === "q") onCancel();
    // Typing the affirmative directly is faster than arrowing over for people who
    // already know what they want.
    if (input === "y") onConfirm();
    if (input === "n") onCancel();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold>{title}</Text>
      {detail ? <Text dimColor>{detail}</Text> : null}
      {danger ? <Text color="red">{danger}</Text> : null}
      <Box marginTop={1}>
        <Text inverse={!yes}> 取消 </Text>
        <Text> </Text>
        <Text inverse={yes} color={yes ? "red" : undefined}>
          {` ${confirmLabel} `}
        </Text>
        <Text dimColor>　{CONFIRM_KEYS}</Text>
      </Box>
    </Box>
  );
}
