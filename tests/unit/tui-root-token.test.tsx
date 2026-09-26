import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfig, updateConfig } from "../../src/config/store.js";
import { Root } from "../../src/tui/app.js";
import type * as TuiData from "../../src/tui/data.js";
import type { DashboardRow } from "../../src/tui/data.js";
import { balanceResponse } from "../fixtures/responses.js";

const row: DashboardRow = {
  instance: {
    uuid: "pro-abc",
    name: "demo",
    status: "running",
    subStatus: null,
    machineId: null,
    regionSign: "bj-B2",
    regionName: "北京B区",
    chargeType: "payg",
    startMode: "gpu",
    gpuSpec: "4090D",
    gpuNum: 1,
    createdAt: null,
    startedAt: null,
    stoppedAt: null,
    expiredAt: null,
    timedShutdownAt: null,
  },
  uptimeSeconds: 60,
  priceYuanPerHour: 1.97,
  estimatedCostYuan: 0.03,
  ttlRemainingMs: 600_000,
  ttlSeconds: 7200,
};

// Only instance polling is unrelated to this seam. Token resolution, persistence,
// wallet requests and the login/session transition use their real implementations.
vi.mock("../../src/tui/data.js", async (importOriginal) => {
  const actual = await importOriginal<typeof TuiData>();
  return {
    ...actual,
    useInstances: () => ({
      rows: [row],
      loading: false,
      error: null,
      authError: null,
      lastUpdated: Date.now(),
      refresh: vi.fn(),
      snapshotFor: () => undefined,
      historyFor: () => undefined,
      loadSnapshot: vi.fn(),
    }),
  };
});

const jwt = (uid: number) =>
  `offline.${Buffer.from(JSON.stringify({ uid })).toString("base64url")}.signature`;
const TOKEN_A = jwt(12345);
const TOKEN_B = jwt(54321);
const TOKEN_C = jwt(99999);
let configDirectory: string;
const rejected = new Set<string>();
interface TestTerminal {
  stdin: { write: (input: string) => void };
  lastFrame: () => string | undefined;
}
const plain = (frame: string | undefined) =>
  (frame ?? "").replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");

beforeEach(() => {
  configDirectory = mkdtempSync(join(tmpdir(), "autodl-root-token-"));
  vi.stubEnv("AUTODL_CONFIG_DIR", configDirectory);
  vi.stubEnv("AUTODL_TOKEN", "");
  vi.stubEnv("AUTODL_BASE_URL", "http://offline.invalid");
  rejected.clear();
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    const token = new Headers(init.headers).get("Authorization") ?? "";
    if (rejected.has(token)) return new Response("{}", { status: 401 });
    const assets = token === TOKEN_A ? 12_000 : token === TOKEN_B ? 34_000 : 99_000;
    return Response.json({
      ...balanceResponse,
      data: { ...balanceResponse.data, assets },
    });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(configDirectory, { recursive: true, force: true });
});

function mount(token?: string) {
  return render(<Root globals={token ? { token } : {}} />);
}

async function until(app: TestTerminal, text: string): Promise<string> {
  await vi.waitFor(() => expect(plain(app.lastFrame())).toContain(text), {
    timeout: 2000,
    interval: 10,
  });
  return plain(app.lastFrame());
}

async function submit(app: TestTerminal, token: string) {
  await until(app, "配置 Token 登入");
  app.stdin.write("\r");
  await until(app, "等待输入");
  app.stdin.write(token);
  await until(app, `(${token.length} 字符)`);
  app.stdin.write("\r");
}

async function logout(source: "flag" | "env") {
  updateConfig({ token: TOKEN_C });
  vi.stubEnv("AUTODL_TOKEN", source === "env" ? TOKEN_A : TOKEN_C);
  const app = mount(source === "flag" ? TOKEN_A : undefined);
  await until(app, "¥12.00");
  app.stdin.write(String.fromCharCode(12));
  await until(app, "退出登录？");
  app.stdin.write("y");
  await until(app, "配置 Token 登入");
  expect(readConfig().token).toBeUndefined();
  return app;
}

describe("the effective account after re-login", () => {
  it.each(["flag", "env"] as const)(
    "preserves the %s override after saving another token",
    async (source) => {
      const app = await logout(source);
      await submit(app, TOKEN_B);
      const frame = await until(app, "¥12.00");
      expect(readConfig().token).toBe(TOKEN_B);
      expect(frame).toContain("12345");
      expect(frame).not.toContain("54321");
      expect(frame).not.toContain(TOKEN_A);
      expect(frame).not.toContain(TOKEN_B);
    },
  );

  it.each(["flag", "env"] as const)(
    "does not fall back when the %s override has expired",
    async (source) => {
      const app = await logout(source);
      rejected.add(TOKEN_A);
      await submit(app, TOKEN_B);
      const frame = await until(app, "HTTP 401");
      expect(readConfig().token).toBe(TOKEN_B);
      expect(frame).not.toContain("demo");
      expect(frame).not.toContain("54321");
      expect(frame).not.toContain(TOKEN_A);
      expect(frame).not.toContain(TOKEN_B);
    },
  );

  it("uses the saved token when neither a flag nor an environment override exists", async () => {
    const app = mount();
    await submit(app, TOKEN_B);
    const frame = await until(app, "¥34.00");
    expect(frame).toContain("54321");
    expect(readConfig().token).toBe(TOKEN_B);
    expect(frame).not.toContain(TOKEN_B);
  });

  it("does not save or enter an account whose input token fails verification", async () => {
    rejected.add(TOKEN_B);
    const app = mount();
    await submit(app, TOKEN_B);
    const frame = await until(app, "HTTP 401");
    expect(readConfig().token).toBeUndefined();
    expect(frame).not.toContain("demo");
    expect(frame).not.toContain(TOKEN_B);
  });
});
