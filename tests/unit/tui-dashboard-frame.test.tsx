import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoDLClient } from "../../src/core/client.js";
import { App } from "../../src/tui/app.js";
import { mockFetch } from "../fixtures/mock-fetch.js";
import { balanceResponse, instanceListResponse, snapshotResponse } from "../fixtures/responses.js";

const terminal = vi.hoisted(() => ({ columns: 80, rows: 40 }));
vi.mock("../../src/tui/useTerminalSize.js", () => ({ useTerminalSize: () => terminal }));
let configDirectory: string;

beforeEach(() => {
  configDirectory = mkdtempSync(join(tmpdir(), "autodl-dashboard-frame-"));
  vi.stubEnv("AUTODL_CONFIG_DIR", configDirectory);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(configDirectory, { recursive: true, force: true });
});

describe("the complete dashboard terminal frame", () => {
  it.each([
    { columns: 80, rows: 24, panels: false },
    { columns: 100, rows: 24, panels: true },
    { columns: 80, rows: 40, panels: true },
  ])(
    "keeps the list, available panels and footer visible at $columns x $rows",
    async ({ columns, rows, panels }) => {
      Object.assign(terminal, { columns, rows });
      const first = { ...instanceListResponse.data.list[0], name: "visible-instance" };
      const transport = mockFetch([
        { path: "/api/v1/dev/wallet/balance", response: balanceResponse },
        {
          path: "/api/v1/dev/instance/pro/list",
          response: {
            ...instanceListResponse,
            data: {
              ...instanceListResponse.data,
              list: [first, { ...first, uuid: "pro-second", name: "uncached-instance" }],
              page_size: 100,
              result_total: 2,
            },
          },
        },
        { path: "/api/v1/dev/instance/pro/snapshot", response: snapshotResponse },
      ]);
      const client = new AutoDLClient({ token: "offline-token", fetchImpl: transport.impl });
      const app = render(
        <App client={client} token="offline-token" tokenSource="config" onLogout={vi.fn()} />,
      );
      const frame = () =>
        (app.lastFrame() ?? "").replace(
          new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"),
          "",
        );
      await vi.waitFor(() => expect(frame()).toContain("¥1.97/时"), {
        timeout: 2000,
        interval: 10,
      });
      const output = frame();
      expect(output).toContain("›visible-instance");
      expect(output).toContain("q 退出");
      expect(output.split("\n").length).toBeLessThanOrEqual(rows);
      if (panels) {
        expect(output).toContain("CPU");
        expect(output).toContain("续航待定");
        expect(output.indexOf("续航待定")).toBeLessThan(output.indexOf("q 退出"));
      } else {
        expect(output).not.toContain("CPU");
        expect(output).not.toContain("续航");
      }
    },
  );
});

it("stops polling immediately when stock rejects the session", async () => {
  // Keep React's timeout scheduler real, but cross both polling intervals without
  // making the regression wait a minute.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  Object.assign(terminal, { columns: 100, rows: 34 });
  const transport = mockFetch([
    { path: "/api/v1/dev/wallet/balance", response: balanceResponse },
    { path: "/api/v1/dev/instance/pro/list", response: instanceListResponse },
    { path: "/api/v1/dev/instance/pro/snapshot", response: snapshotResponse },
    { path: "/api/v1/dev/machine/region/gpu_stock", status: 401, response: {} },
  ]);
  const client = new AutoDLClient({ token: "offline-token", fetchImpl: transport.impl });
  const app = render(
    <App client={client} token="offline-token" tokenSource="config" onLogout={vi.fn()} />,
  );
  await vi.waitFor(() => expect(app.lastFrame()).toContain("¥1.97/时"));
  const pollingRequests = () =>
    transport.calls.filter((call) => !new URL(call.url).pathname.endsWith("/gpu_stock")).length;
  const before = pollingRequests();
  app.stdin.write("g");
  await vi.waitFor(() => expect(app.lastFrame()).toContain("登录状态已失效"));
  await vi.advanceTimersByTimeAsync(65_000);
  expect(pollingRequests()).toBe(before);
  expect(app.lastFrame()).toContain("重新登入");
});
