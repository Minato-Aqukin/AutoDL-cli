import { vi } from "vitest";

export interface MockCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/** A canned body, or a responder that can vary the body per call (for retry tests). */
export type MockResponder =
  | Record<string, unknown>
  | unknown[]
  | ((call: MockCall, index: number) => unknown);

export interface MockRoute {
  /** Matched against the URL pathname. */
  path: string;
  status?: number;
  response: MockResponder;
  /** Status per call index, for exercising retry paths. */
  statuses?: number[];
}

/**
 * A fetch stand-in that records calls and replays canned AutoDL envelopes.
 * Preferred over hitting the network so the suite stays deterministic and free.
 */
export function mockFetch(routes: MockRoute[]) {
  const calls: MockCall[] = [];
  const counts = new Map<string, number>();

  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(url);
    const route = routes.find((r) => parsed.pathname === r.path);
    if (!route) throw new Error(`mockFetch: 未注册的路径 ${parsed.pathname}`);

    const index = counts.get(route.path) ?? 0;
    counts.set(route.path, index + 1);

    const call: MockCall = {
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);

    const status = route.statuses?.[index] ?? route.status ?? 200;
    const payload =
      typeof route.response === "function" ? route.response(call, index) : route.response;

    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  });

  /** Indexed access that fails loudly instead of returning undefined. */
  const callAt = (index: number): MockCall => {
    const call = calls[index];
    if (!call) throw new Error(`mockFetch: 第 ${index} 次调用不存在（共 ${calls.length} 次）`);
    return call;
  };

  return { impl: impl as unknown as typeof fetch, calls, callAt, raw: impl };
}
