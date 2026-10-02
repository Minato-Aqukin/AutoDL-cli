import { Buffer } from "node:buffer";
import { setTimeout as sleep } from "node:timers/promises";
import { render } from "ink-testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ImageEndpoints from "../../src/core/endpoints/image.js";
import { App } from "../../src/tui/app.js";
import type * as TuiData from "../../src/tui/data.js";
import type { DashboardRow } from "../../src/tui/data.js";

/**
 * Saving an image from the detail screen.
 *
 * The name is free text typed into a modal, so letters the dashboard binds — `q` quits,
 * `i` opens this very prompt — have to land in the field, and Enter on an empty field
 * must not submit a nameless save.
 */

const row: DashboardRow = {
  instance: {
    uuid: "pro-abc",
    name: "demo",
    status: "stopped",
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
  uptimeSeconds: null,
  priceYuanPerHour: null,
  estimatedCostYuan: null,
  ttlRemainingMs: null,
  ttlSeconds: null,
};

const save = vi.hoisted(() => vi.fn(async (): Promise<string> => "image-new"));

vi.mock("../../src/core/endpoints/image.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ImageEndpoints>();
  return { ...actual, saveImage: save };
});

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

const ENTER = "\r";
const ESC = String.fromCharCode(27);
const PROMPT_TITLE = "为私有镜像";
const flush = () => sleep(40);
const TOKEN = [
  "header",
  Buffer.from(JSON.stringify({ uid: 785976 })).toString("base64url"),
  "sig",
].join(".");

/** Mount, open the detail screen, and press the save key. */
async function openPrompt() {
  const app = render(
    <App client={{} as never} token={TOKEN} tokenSource="config" onLogout={vi.fn()} />,
  );
  await flush();
  app.stdin.write(ENTER);
  await flush();
  app.stdin.write("i");
  await flush();
  expect(app.lastFrame()).toContain(PROMPT_TITLE);
  return app;
}

beforeEach(() => {
  save.mockClear();
});

describe("saving an image from the detail screen", () => {
  it("saves the selected instance under the typed name, bound letters included", async () => {
    const { stdin } = await openPrompt();
    for (const char of "qi-env") {
      stdin.write(char);
      await flush();
    }
    stdin.write(ENTER);
    await flush();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(expect.anything(), "pro-abc", "qi-env");
  });

  it("does not submit an empty name, and saves nothing when cancelled", async () => {
    const { stdin, lastFrame } = await openPrompt();
    stdin.write(ENTER);
    await flush();
    expect(lastFrame()).toContain(PROMPT_TITLE);

    stdin.write(ESC);
    await flush();
    expect(lastFrame()).not.toContain(PROMPT_TITLE);
    expect(save).not.toHaveBeenCalled();
  });
});
