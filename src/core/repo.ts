import { UsageError } from "./errors.js";

/**
 * Parsing and safe assembly of code-hosting URLs.
 *
 * The token handling here is the security-sensitive part: a credential embedded in a
 * clone URL must never reach a log line, an error message, `--json` output, or the
 * remote's stored git config. Everything that builds a URL with a token also provides
 * a redacted twin for display.
 */

export interface ParsedRepo {
  /** Host as given, e.g. `github.com`. */
  host: string;
  /** `owner/name` path, without a trailing `.git`. */
  path: string;
  /** Last path segment — the default directory name. */
  name: string;
  /** Normalised https clone URL, never containing credentials. */
  cloneUrl: string;
  /** True when AutoDL's academic proxy covers this host. */
  needsAcceleration: boolean;
}

/** Hosts covered by `source /etc/network_turbo`, per AutoDL's docs. */
const ACCELERATED_HOSTS = new Set([
  "github.com",
  "raw.githubusercontent.com",
  "githubusercontent.com",
  "githubassets.com",
  "huggingface.co",
]);

const SCP_LIKE = /^(?:([^@]+)@)?([^:/]+):(.+)$/;

/**
 * Accept the forms people actually paste: https URLs, `git@host:owner/repo.git`,
 * and bare `owner/repo` (assumed GitHub, matching how most tools behave).
 */
export function parseRepo(input: string): ParsedRepo {
  const trimmed = input.trim();
  if (!trimmed) throw new UsageError("仓库地址不能为空");

  let host: string;
  let path: string;

  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new UsageError(`无法解析仓库地址 "${input}"`);
    }
    host = url.hostname;
    path = url.pathname;
  } else if (trimmed.startsWith("git@") || SCP_LIKE.test(trimmed)) {
    const match = SCP_LIKE.exec(trimmed);
    if (!match) throw new UsageError(`无法解析仓库地址 "${input}"`);
    host = match[2] as string;
    path = match[3] as string;
  } else if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    // Bare owner/repo — assume GitHub, the overwhelmingly common case.
    host = "github.com";
    path = trimmed;
  } else {
    throw new UsageError(`无法解析仓库地址 "${input}"`, {
      hint: "支持 https://github.com/owner/repo、git@github.com:owner/repo.git 或 owner/repo。",
    });
  }

  path = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  if (!path?.includes("/")) {
    throw new UsageError(`仓库地址缺少 owner/name："${input}"`);
  }

  const name = path.split("/").pop() as string;
  return {
    host,
    path,
    name,
    cloneUrl: `https://${host}/${path}.git`,
    needsAcceleration: ACCELERATED_HOSTS.has(host),
  };
}

/**
 * Clone URL with a token embedded, plus the redacted form to show instead.
 *
 * Callers must use `display` for every user-visible surface — the raw URL is only ever
 * allowed inside the command string sent over SSH.
 */
export function withCredentials(
  repo: ParsedRepo,
  token?: string,
): { url: string; display: string } {
  if (!token) return { url: repo.cloneUrl, display: repo.cloneUrl };
  // `x-access-token` is what GitHub expects; GitLab and Gitee accept it as the username
  // for token auth too, so one shape covers all three.
  return {
    url: `https://x-access-token:${token}@${repo.host}/${repo.path}.git`,
    display: `https://x-access-token:***@${repo.host}/${repo.path}.git`,
  };
}

/** Strip any embedded credential from arbitrary text before it is displayed or stored. */
export function redactCredentials(text: string): string {
  return text.replace(/(https?:\/\/)([^/@\s]+)@/gi, "$1***@");
}

/** Resolve a git token from the flag, then the usual environment variables. */
export function resolveGitToken(explicit?: string): string | undefined {
  const candidate =
    explicit ?? process.env.GIT_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GITEE_TOKEN;
  return candidate?.trim() ? candidate.trim() : undefined;
}
