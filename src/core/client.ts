import { Buffer } from "node:buffer";
import { request as httpsRequest } from "node:https";
import {
  AuthError,
  AutoDLError,
  BudgetError,
  NoStockError,
  NotFoundError,
  TimeoutError,
} from "./errors.js";

export const DEFAULT_BASE_URL = "https://api.autodl.com";

/** Shape every AutoDL endpoint wraps its payload in. */
interface Envelope<T> {
  code: string;
  msg: string;
  data: T;
  request_id?: string;
}

export interface ClientOptions {
  token: string;
  baseUrl?: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Retry attempts for transient failures (network, 429, 5xx). */
  maxRetries?: number;
  /** Base delay for exponential backoff. Lowered in tests to keep the suite fast. */
  retryBaseDelayMs?: number;
  /** Called with sanitised request/response summaries when --verbose is on. */
  onDebug?: (message: string) => void;
  fetchImpl?: typeof fetch;
}

interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
  /** Override the retry budget for a single call (e.g. 0 for non-idempotent creates). */
  maxRetries?: number;
  timeoutMs?: number;
}

/** Never let a token reach a log line intact. */
export function redactToken(token: string): string {
  if (token.length <= 8) return "****";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with full jitter, capped so an agent never stalls for minutes. */
function backoffDelay(attempt: number, baseMs: number): number {
  const base = Math.min(baseMs * 2 ** attempt, 15_000);
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * A few AutoDL endpoints are documented as `GET` with a JSON body, which the WHATWG
 * fetch spec forbids. We send those as query strings first (the Go backend binds both),
 * and fall back to a raw GET-with-body only if the server complains about the params.
 */
const getBodyFallback = new Set<string>();

export class AutoDLClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly onDebug: ((message: string) => void) | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions) {
    if (!options.token) {
      throw new AuthError("未配置 AutoDL 开发者 Token", {
        code: "AUTH_MISSING",
        hint: "运行 `autodl login`，或设置环境变量 AUTODL_TOKEN。Token 在 AutoDL 控制台 → 设置 → 开发者 Token 获取。",
      });
    }
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 4;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1000;
    this.onDebug = options.onDebug;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  get maskedToken(): string {
    return redactToken(this.token);
  }

  async get<T>(path: string, body?: Record<string, unknown>, extra?: Partial<RequestOptions>) {
    return this.request<T>({ method: "GET", path, body, ...extra });
  }

  async post<T>(path: string, body?: Record<string, unknown>, extra?: Partial<RequestOptions>) {
    return this.request<T>({ method: "POST", path, body, ...extra });
  }

  async put<T>(path: string, body?: Record<string, unknown>, extra?: Partial<RequestOptions>) {
    return this.request<T>({ method: "PUT", path, body, ...extra });
  }

  async delete<T>(path: string, body?: Record<string, unknown>, extra?: Partial<RequestOptions>) {
    return this.request<T>({ method: "DELETE", path, body, ...extra });
  }

  async request<T>(options: RequestOptions): Promise<T> {
    const retries = options.maxRetries ?? this.maxRetries;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.attempt<T>(options);
      } catch (err) {
        lastError = err;
        const retriable = err instanceof AutoDLError && err.details?.retriable === true;
        if (!retriable || attempt === retries) break;
        const delay = backoffDelay(attempt, this.retryBaseDelayMs);
        this.debug(`重试 ${options.method} ${options.path}（第 ${attempt + 1} 次，${delay}ms 后）`);
        await sleep(delay);
      }
    }
    throw lastError;
  }

  private debug(message: string): void {
    this.onDebug?.(message);
  }

  private async attempt<T>(options: RequestOptions): Promise<T> {
    const { method, path, body } = options;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const useGetBody = method === "GET" && getBodyFallback.has(path);

    let envelope: Envelope<T>;
    if (useGetBody) {
      envelope = await this.rawGetWithBody<T>(path, body ?? {}, timeoutMs);
    } else {
      envelope = await this.fetchJson<T>(method, path, body, timeoutMs);
    }

    if (envelope.code === "Success") {
      return envelope.data;
    }

    // A GET that failed on missing params is our signal to switch that path to
    // body-carrying GETs for the rest of the process.
    if (method === "GET" && !useGetBody && looksLikeMissingParam(envelope.msg)) {
      getBodyFallback.add(path);
      this.debug(`${path} 需要 GET 携带 body，切换传输方式后重试`);
      const retried = await this.rawGetWithBody<T>(path, body ?? {}, timeoutMs);
      if (retried.code === "Success") return retried.data;
      throw mapEnvelopeError(retried.code, retried.msg, retried.request_id);
    }

    throw mapEnvelopeError(envelope.code, envelope.msg, envelope.request_id);
  }

  private async fetchJson<T>(
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
    timeoutMs: number,
  ): Promise<Envelope<T>> {
    const url = new URL(this.baseUrl + path);
    let payload: string | undefined;

    if (method === "GET") {
      for (const [key, value] of Object.entries(body ?? {})) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(
          key,
          typeof value === "object" ? JSON.stringify(value) : String(value),
        );
      }
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
    }

    this.debug(`${method} ${url.pathname}${url.search} token=${this.maskedToken}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: this.token,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "autodl-cli",
        },
        ...(payload !== undefined ? { body: payload } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new TimeoutError(`请求超时：${method} ${path}`, {
          details: { retriable: true },
          cause: err,
        });
      }
      throw new AutoDLError(`网络请求失败：${method} ${path}`, {
        code: "NETWORK",
        details: { retriable: true },
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }

    return this.readEnvelope<T>(response.status, await response.text(), method, path);
  }

  /** GET with a JSON body — legal HTTP/1.1, but fetch refuses, so drop to node:https. */
  private rawGetWithBody<T>(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Envelope<T>> {
    const url = new URL(this.baseUrl + path);
    const payload = Buffer.from(JSON.stringify(body));

    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: "GET",
          headers: {
            Authorization: this.token,
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": "autodl-cli",
            "Content-Length": payload.byteLength,
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            try {
              resolve(
                this.readEnvelope<T>(
                  res.statusCode ?? 0,
                  Buffer.concat(chunks).toString("utf8"),
                  "GET",
                  path,
                ),
              );
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on("timeout", () => {
        req.destroy();
        reject(new TimeoutError(`请求超时：GET ${path}`, { details: { retriable: true } }));
      });
      req.on("error", (err) =>
        reject(
          new AutoDLError(`网络请求失败：GET ${path}`, {
            code: "NETWORK",
            details: { retriable: true },
            cause: err,
          }),
        ),
      );
      req.end(payload);
    });
  }

  private readEnvelope<T>(status: number, text: string, method: string, path: string): Envelope<T> {
    if (status === 401 || status === 403) {
      throw new AuthError(`Token 无效或已失效（HTTP ${status}）`, {
        hint: "重新运行 `autodl login` 写入新的开发者 Token。",
      });
    }
    if (isRetriableStatus(status)) {
      throw new AutoDLError(`AutoDL 服务暂时不可用（HTTP ${status}）：${method} ${path}`, {
        code: "API_ERROR",
        details: { retriable: true, status },
      });
    }

    let parsed: Envelope<T>;
    try {
      parsed = JSON.parse(text) as Envelope<T>;
    } catch (err) {
      throw new AutoDLError(`无法解析 AutoDL 响应（HTTP ${status}）`, {
        code: "API_ERROR",
        details: { status, snippet: text.slice(0, 200) },
        cause: err,
      });
    }

    if (status >= 400 && parsed.code === undefined) {
      throw new AutoDLError(`AutoDL 返回 HTTP ${status}：${method} ${path}`, {
        code: "API_ERROR",
        details: { status },
      });
    }
    return parsed;
  }
}

function looksLikeMissingParam(msg: string): boolean {
  const m = (msg ?? "").toLowerCase();
  return (
    m.includes("param") ||
    m.includes("bind") ||
    m.includes("required") ||
    msg.includes("参数") ||
    msg.includes("必填")
  );
}

/**
 * AutoDL signals logical failures with HTTP 200 + a non-Success `code`, and the docs
 * don't enumerate the codes. We match on both code and message so the CLI can still
 * hand agents a precise exit code.
 */
export function mapEnvelopeError(code: string, msg: string, requestId?: string): AutoDLError {
  const text = `${code} ${msg}`;
  const lower = text.toLowerCase();
  const message = msg?.trim() ? msg.trim() : `AutoDL 返回错误：${code}`;
  const opts = { requestId, details: { apiCode: code } };

  if (lower.includes("token") || lower.includes("auth") || lower.includes("unauthor")) {
    return new AuthError(message, {
      ...opts,
      hint: "确认 Token 未过期且账号已完成实名认证。",
    });
  }
  if (text.includes("实名")) {
    return new AuthError(message, {
      ...opts,
      hint: "官方开放 API 要求完成个人或企业实名认证后才能调用。",
    });
  }
  if (text.includes("余额") || lower.includes("balance") || lower.includes("insufficient fund")) {
    return new BudgetError(message, { ...opts, hint: "请先充值，或降低所需 GPU 规格。" });
  }
  if (
    text.includes("库存") ||
    text.includes("无可用") ||
    text.includes("资源不足") ||
    text.includes("售罄") ||
    lower.includes("no stock") ||
    lower.includes("sold out") ||
    lower.includes("no available")
  ) {
    return new NoStockError(message, {
      ...opts,
      hint: "官方 API 没有库存查询接口，只能换 GPU 规格或地区重试。",
    });
  }
  if (text.includes("不存在") || lower.includes("not found") || lower.includes("no such")) {
    return new NotFoundError(message, opts);
  }
  return new AutoDLError(message, { ...opts, code: "API_ERROR" });
}
