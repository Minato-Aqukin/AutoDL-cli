import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import { configPath } from "../../config/store.js";
import { BrandMark } from "../components/header.js";
import { useTerminalSize } from "../useTerminalSize.js";

/**
 * Token entry, shown when the TUI starts without credentials.
 *
 * The dashboard is the default surface now, so it has to be reachable before you have a
 * token — otherwise a first-time user types `autodl`, gets an error, and has to go read
 * the docs to find out what to do next.
 */

type Stage = "menu" | "input";

interface LoginProps {
  /** Verify, then persist. A rejection shows the reason without leaving the screen. */
  onSubmit: (token: string) => void;
  onQuit: () => void;
  error: string | null;
  verifying: boolean;
}

/** Strip control characters a paste or stray key can smuggle into the field. */
function sanitize(input: string): string {
  let out = "";
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) out += char;
  }
  return out;
}

export function Login({ onSubmit, onQuit, error, verifying }: LoginProps): React.ReactElement {
  const { columns, rows } = useTerminalSize();
  const [stage, setStage] = useState<Stage>("menu");
  const [choice, setChoice] = useState(0);
  const [token, setToken] = useState("");

  useInput((input, key) => {
    if (verifying) return;

    if (stage === "menu") {
      if (key.upArrow || key.downArrow || input === "j" || input === "k") {
        setChoice((v) => (v === 0 ? 1 : 0));
        return;
      }
      if (key.return) {
        if (choice === 0) setStage("input");
        else onQuit();
        return;
      }
      if (input === "q" || key.escape) onQuit();
      return;
    }

    if (key.escape) {
      setStage("menu");
      setToken("");
      return;
    }
    if (key.return) {
      if (token.trim()) onSubmit(token.trim());
      return;
    }
    if (key.backspace || key.delete) {
      setToken((v) => v.slice(0, -1));
      return;
    }
    // Ink delivers a paste as a single chunk, so appending covers typing and pasting
    // alike — and a JWT is far too long to type by hand.
    const clean = sanitize(input);
    if (clean) setToken((v) => v + clean);
  });

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      <BrandMark subtitle="登入" columns={columns} />
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        {stage === "menu" ? (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>尚未配置开发者 Token，请先登入。</Text>
            <Box flexDirection="column" marginTop={1}>
              <Text inverse={choice === 0}>{choice === 0 ? "› " : "  "}配置 Token 登入</Text>
              <Text inverse={choice === 1}>{choice === 1 ? "› " : "  "}退出</Text>
            </Box>
            <Box marginTop={1}>
              <Text dimColor>↑↓ 选择 · Enter 确定 · q 退出</Text>
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>粘贴你的开发者 Token：</Text>
            <Text dimColor>AutoDL 控制台 → 设置 → 开发者 Token（需先完成实名认证）</Text>
            <Box marginTop={1}>
              <Text>{"› "}</Text>
              {/* Masked: it is a credential. The length confirms a paste actually landed. */}
              <Text color="green">{token ? "•".repeat(Math.min(token.length, 48)) : ""}</Text>
              <Text dimColor>{token ? ` (${token.length} 字符)` : "等待输入…"}</Text>
            </Box>
            <Box marginTop={1}>
              <Text dimColor>
                {verifying ? "正在验证…" : "Enter 验证并保存 · Esc 返回 · 支持直接粘贴"}
              </Text>
            </Box>
          </Box>
        )}

        {error ? (
          <Box marginTop={1}>
            <Text color="red">✖ {error}</Text>
          </Box>
        ) : null}

        <Box marginTop={1}>
          <Text dimColor>验证通过后会保存到 {configPath()}（权限 0600）</Text>
        </Box>
      </Box>
    </Box>
  );
}
