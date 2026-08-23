import { resolveBaseUrl, resolveToken } from "./config/store.js";
import { AutoDLClient } from "./core/client.js";
import { sweepExpired } from "./guard/ttl.js";
import { configureOutput, debug } from "./output/format.js";
import { type Lang, resolveLang, setLang } from "./output/i18n.js";

export interface GlobalOptions {
  token?: string;
  baseUrl?: string;
  json?: boolean;
  color?: boolean;
  verbose?: boolean;
  lang?: string;
  /**
   * Whether to run the opportunistic TTL sweep. Commander's `--no-sweep` sets this to
   * `false` (it does NOT produce a `noSweep` key), so the check below tests for an
   * explicit `false` rather than for truthiness of a negated name.
   */
  sweep?: boolean;
}

export interface Context {
  client: AutoDLClient;
  lang: Lang;
}

/**
 * Build the client every command shares.
 *
 * Kept separate from the commander wiring so the MCP server can construct an identical
 * context — the two entry points must never drift in how they resolve tokens, honour
 * env vars, or apply guards.
 */
export function createContext(options: GlobalOptions = {}): Context {
  const lang = resolveLang(options.lang);
  setLang(lang);
  configureOutput({
    json: options.json ?? false,
    color: options.color ?? true,
    verbose: options.verbose ?? false,
  });

  const { token, source } = resolveToken(options.token);
  debug(`Token 来源：${source}`);

  const client = new AutoDLClient({
    token,
    ...(resolveBaseUrl(options.baseUrl) ? { baseUrl: resolveBaseUrl(options.baseUrl) } : {}),
    onDebug: debug,
  });

  return { client, lang };
}

/**
 * Reclaim instances past their TTL before doing anything else.
 *
 * Deliberately best-effort: a sweep failure must never stop the command the user
 * actually ran, but every CLI and MCP invocation gets a chance to clean up.
 */
export async function runOpportunisticSweep(
  context: Context,
  options: GlobalOptions,
): Promise<void> {
  if (options.sweep === false || process.env.AUTODL_NO_SWEEP === "1") return;
  try {
    await sweepExpired(context.client);
  } catch (err) {
    debug(`TTL 清理失败（已忽略）：${(err as Error).message}`);
  }
}
