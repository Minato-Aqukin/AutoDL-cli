import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AuthError } from "../core/errors.js";

export interface StoredConfig {
  token?: string;
  baseUrl?: string;
  lang?: "zh" | "en";
  defaults?: {
    gpu?: string;
    image?: string;
    regions?: string[];
    ttl?: string;
    minBalanceYuan?: number;
  };
}

/** Honour XDG on Linux, fall back to ~/.config elsewhere. */
export function configDir(): string {
  const override = process.env.AUTODL_CONFIG_DIR;
  if (override) return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg?.trim() ? xdg : join(homedir(), ".config"), "autodl-cli");
}

export const configPath = (): string => join(configDir(), "config.json");

export function readConfig(): StoredConfig {
  const file = configPath();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as StoredConfig;
  } catch {
    // A corrupt config shouldn't brick the CLI — treat it as empty.
    return {};
  }
}

/** Write config with 0600 so a shared machine can't read the token. */
export function writeConfig(config: StoredConfig): void {
  const file = configPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function updateConfig(patch: Partial<StoredConfig>): StoredConfig {
  const next = { ...readConfig(), ...patch };
  writeConfig(next);
  return next;
}

export function clearToken(): void {
  const config = readConfig();
  delete config.token;
  if (Object.keys(config).length === 0) {
    if (existsSync(configPath())) rmSync(configPath());
    return;
  }
  writeConfig(config);
}

export interface TokenResolution {
  token: string;
  source: "flag" | "env" | "config";
}

/**
 * Token precedence: explicit flag > AUTODL_TOKEN > config file.
 * Throws a AUTH_MISSING error (exit 3) with setup instructions when nothing is found.
 */
export function resolveToken(explicit?: string): TokenResolution {
  if (explicit?.trim()) return { token: explicit.trim(), source: "flag" };

  const fromEnv = process.env.AUTODL_TOKEN;
  if (fromEnv?.trim()) return { token: fromEnv.trim(), source: "env" };

  const fromConfig = readConfig().token;
  if (fromConfig?.trim()) return { token: fromConfig.trim(), source: "config" };

  throw new AuthError("未配置 AutoDL 开发者 Token", {
    code: "AUTH_MISSING",
    hint: "运行 `autodl login` 交互写入，或设置 AUTODL_TOKEN 环境变量。Token 位置：AutoDL 控制台 → 设置 → 开发者 Token（需先完成实名认证）。",
  });
}

export function resolveBaseUrl(explicit?: string): string | undefined {
  return explicit ?? process.env.AUTODL_BASE_URL ?? readConfig().baseUrl;
}
