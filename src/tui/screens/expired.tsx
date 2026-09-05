import { Box, Text, useInput } from "ink";
import type React from "react";

/**
 * Shown when the API rejects the token mid-session.
 *
 * A dashboard whose every request 401s is worse than useless: the numbers on it are
 * frozen at whatever they were before the token died, while the error line implies a
 * transient fault a refresh might clear. This screen says the session is over and
 * offers the only two things that help — log in again, or leave.
 */

interface SessionExpiredProps {
  /** What the API actually said, kept verbatim rather than paraphrased. */
  message: string;
  onRelogin: () => void;
  onQuit: () => void;
}

export function SessionExpired({
  message,
  onRelogin,
  onQuit,
}: SessionExpiredProps): React.ReactElement {
  useInput((input, key) => {
    if (key.return) return onRelogin();
    if (input === "q" || key.escape) return onQuit();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
      <Text bold color="red">
        登录状态已失效
      </Text>
      <Text>{message}</Text>
      <Text dimColor>Token 可能已过期、被重置，或账号实名状态发生了变化。</Text>
      <Text dimColor>已暂停刷新，实例数据停留在失效前的状态。</Text>
      <Box marginTop={1}>
        <Text>Enter 重新登入 · q 退出</Text>
      </Box>
    </Box>
  );
}
