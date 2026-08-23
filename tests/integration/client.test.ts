import { describe, expect, it, vi } from "vitest";
import { AutoDLClient, mapEnvelopeError, redactToken } from "../../src/core/client.js";
import {
  AuthError,
  BudgetError,
  NoStockError,
  NotFoundError,
  TimeoutError,
} from "../../src/core/errors.js";
import { mockFetch } from "../fixtures/mock-fetch.js";
import { balanceResponse } from "../fixtures/responses.js";

const token = "tok_abcdefghijklmnop";

function makeClient(fetchImpl: typeof fetch, overrides = {}) {
  // retryBaseDelayMs keeps the backoff path exercised without the real 1s+ waits.
  return new AutoDLClient({ token, fetchImpl, maxRetries: 2, retryBaseDelayMs: 1, ...overrides });
}

describe("authentication", () => {
  it("sends the raw token in the Authorization header, as AutoDL expects", async () => {
    const fetchMock = mockFetch([
      { path: "/api/v1/dev/wallet/balance", response: balanceResponse },
    ]);
    await makeClient(fetchMock.impl).post("/api/v1/dev/wallet/balance", {});
    expect(fetchMock.callAt(0).headers.Authorization).toBe(token);
  });

  it("refuses to construct without a token", () => {
    expect(() => new AutoDLClient({ token: "" })).toThrow(AuthError);
  });

  it("never exposes the token in full", () => {
    expect(makeClient(mockFetch([]).impl).maskedToken).toBe("tok_…mnop");
    expect(redactToken("short")).toBe("****");
  });
});

describe("retry behaviour", () => {
  it("retries 5xx responses and succeeds on a later attempt", async () => {
    const fetchMock = mockFetch([
      {
        path: "/api/v1/dev/wallet/balance",
        statuses: [500, 503, 200],
        response: balanceResponse,
      },
    ]);
    const data = await makeClient(fetchMock.impl).post<{ assets: number }>(
      "/api/v1/dev/wallet/balance",
      {},
    );
    expect(data.assets).toBe(12_340);
    expect(fetchMock.calls).toHaveLength(3);
  });

  it("retries 429 rate limiting", async () => {
    const fetchMock = mockFetch([
      { path: "/api/v1/dev/wallet/balance", statuses: [429, 200], response: balanceResponse },
    ]);
    await makeClient(fetchMock.impl).post("/api/v1/dev/wallet/balance", {});
    expect(fetchMock.calls).toHaveLength(2);
  });

  it("gives up after the retry budget and surfaces the failure", async () => {
    const fetchMock = mockFetch([
      { path: "/api/v1/dev/wallet/balance", status: 500, response: { code: "Fail" } },
    ]);
    await expect(makeClient(fetchMock.impl).post("/api/v1/dev/wallet/balance", {})).rejects.toThrow(
      /暂时不可用/,
    );
    expect(fetchMock.calls).toHaveLength(3); // initial + 2 retries
  });

  it("does not retry a logical (HTTP 200) API error", async () => {
    // Retrying these would be pointless and, for creates, expensive.
    const fetchMock = mockFetch([
      { path: "/api/v1/dev/wallet/balance", response: { code: "Fail", msg: "参数错误" } },
    ]);
    await expect(
      makeClient(fetchMock.impl).post("/api/v1/dev/wallet/balance", {}),
    ).rejects.toThrow();
    expect(fetchMock.calls).toHaveLength(1);
  });

  it("honours a per-call maxRetries of 0 for non-idempotent operations", async () => {
    const fetchMock = mockFetch([
      { path: "/api/v1/dev/instance/pro/create", status: 500, response: {} },
    ]);
    await expect(
      makeClient(fetchMock.impl).post("/api/v1/dev/instance/pro/create", {}, { maxRetries: 0 }),
    ).rejects.toThrow();
    // Creating twice would rent two GPUs.
    expect(fetchMock.calls).toHaveLength(1);
  });
});

describe("HTTP status handling", () => {
  it("maps 401/403 to an auth error so the CLI exits 3", async () => {
    const fetchMock = mockFetch([
      { path: "/api/v1/dev/wallet/balance", status: 401, response: {} },
    ]);
    await expect(makeClient(fetchMock.impl).post("/api/v1/dev/wallet/balance", {})).rejects.toThrow(
      AuthError,
    );
  });

  it("does not retry a 401 — a bad token stays bad", async () => {
    const fetchMock = mockFetch([
      { path: "/api/v1/dev/wallet/balance", status: 403, response: {} },
    ]);
    await expect(
      makeClient(fetchMock.impl).post("/api/v1/dev/wallet/balance", {}),
    ).rejects.toThrow();
    expect(fetchMock.calls).toHaveLength(1);
  });

  it("reports unparseable bodies instead of throwing a raw SyntaxError", async () => {
    const impl = vi.fn(async () => new Response("<html>502</html>", { status: 200 }));
    await expect(
      makeClient(impl as unknown as typeof fetch).post("/api/v1/dev/wallet/balance", {}),
    ).rejects.toThrow(/无法解析/);
  });
});

describe("GET requests", () => {
  it("sends parameters as a query string, since fetch forbids a GET body", async () => {
    const fetchMock = mockFetch([
      { path: "/api/v1/dev/instance/pro/status", response: { code: "Success", data: "running" } },
    ]);
    const status = await makeClient(fetchMock.impl).get<string>("/api/v1/dev/instance/pro/status", {
      instance_uuid: "pro-1",
    });
    expect(status).toBe("running");
    expect(fetchMock.callAt(0).url).toContain("instance_uuid=pro-1");
  });

  it("falls back to a body-carrying GET when the server rejects the query form", async () => {
    // The docs show these endpoints as GET-with-JSON-body; the query form is our
    // first guess, and this is the escape hatch if a deployment insists on the body.
    const fetchMock = mockFetch([
      {
        path: "/api/v1/dev/instance/pro/gettest",
        response: { code: "Fail", msg: "missing required param" },
      },
    ]);
    // The fallback drops to node:https, which bypasses our fetch mock. Point it at a
    // closed local port so the attempt fails immediately instead of reaching AutoDL.
    const client = makeClient(fetchMock.impl, { baseUrl: "https://127.0.0.1:1" });
    await expect(
      client.get("/api/v1/dev/instance/pro/gettest", { instance_uuid: "pro-1" }),
    ).rejects.toThrow(/网络请求失败/);
    expect(fetchMock.calls).toHaveLength(1);
  });
});

describe("timeouts", () => {
  it("aborts a hung request and reports a timeout", async () => {
    const impl = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );
    const client = makeClient(impl as unknown as typeof fetch, { timeoutMs: 20, maxRetries: 0 });
    await expect(client.post("/api/v1/dev/wallet/balance", {})).rejects.toThrow(TimeoutError);
  });
});

describe("mapEnvelopeError", () => {
  it("classifies real-name / token problems as auth failures (exit 3)", () => {
    expect(mapEnvelopeError("Fail", "token 已过期")).toBeInstanceOf(AuthError);
    expect(mapEnvelopeError("Fail", "请先完成实名认证")).toBeInstanceOf(AuthError);
  });

  it("classifies balance problems as budget failures (exit 5)", () => {
    expect(mapEnvelopeError("Fail", "账户余额不足")).toBeInstanceOf(BudgetError);
    expect(mapEnvelopeError("Fail", "insufficient funds")).toBeInstanceOf(BudgetError);
  });

  it("classifies stock problems as NO_STOCK (exit 6)", () => {
    // The docs don't enumerate these codes, so we match on message text too.
    expect(mapEnvelopeError("Fail", "当前地区无可用资源")).toBeInstanceOf(NoStockError);
    expect(mapEnvelopeError("Fail", "GPU 库存不足")).toBeInstanceOf(NoStockError);
    expect(mapEnvelopeError("Fail", "sold out")).toBeInstanceOf(NoStockError);
  });

  it("classifies missing resources as NOT_FOUND (exit 4)", () => {
    expect(mapEnvelopeError("Fail", "实例不存在")).toBeInstanceOf(NotFoundError);
    expect(mapEnvelopeError("Fail", "instance not found")).toBeInstanceOf(NotFoundError);
  });

  it("preserves the request_id for support tickets", () => {
    expect(mapEnvelopeError("Fail", "boom", "req-123").requestId).toBe("req-123");
  });

  it("falls back to a generic API error for unrecognised codes", () => {
    const error = mapEnvelopeError("SomeNewCode", "未知错误");
    expect(error.code).toBe("API_ERROR");
    expect(error.exitCode).toBe(1);
  });
});
