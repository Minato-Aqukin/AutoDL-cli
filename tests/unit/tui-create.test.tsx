import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listTracked } from "../../src/config/state.js";
import { BASE_IMAGES, DEFAULT_BASE_IMAGE, parseCudaVersion } from "../../src/core/catalog.js";
import type * as ImageEndpoints from "../../src/core/endpoints/image.js";
import type { DashboardRow } from "../../src/tui/data.js";

/**
 * What the create wizard actually sends.
 *
 * The wizard lets you pick an image and prints the CUDA version it carries, so the
 * `cuda_v_from` on the create call has to be that image's — every other create path in
 * this codebase derives it the same way. The TUI used to send a hardcoded 11.8 no matter
 * which image was chosen a screen earlier.
 */

interface CreatePayload {
  imageUuid: string;
  cudaFrom: number;
}

const create = vi.hoisted(() =>
  vi.fn(async (_client: unknown, _input: unknown): Promise<string> => "pro-new"),
);

vi.mock("../../src/core/endpoints/image.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ImageEndpoints>();
  return {
    ...actual,
    listAllPrivateImages: vi.fn(async () => [
      {
        imageUuid: "image-mine",
        name: "my-env",
        status: "finished",
        sizeBytes: 1,
        createdAt: null,
      },
      {
        imageUuid: "image-saving",
        name: "wip",
        status: "saving",
        sizeBytes: 0,
        createdAt: null,
      },
    ]),
  };
});

vi.mock("../../src/core/endpoints/instance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/endpoints/instance.js")>();
  return {
    ...actual,
    createInstance: create,
    listAllInstances: vi.fn(async () => []),
  };
});

vi.mock("../../src/tui/data.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tui/data.js")>();
  const row: DashboardRow = {
    instance: {
      uuid: "pro-new",
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

const { App } = await import("../../src/tui/app.js");

const flush = () => new Promise((resolve) => setTimeout(resolve, 40));
const ENTER = "\r";
const TOKEN = [
  "header",
  Buffer.from(JSON.stringify({ uid: 785976 })).toString("base64url"),
  "sig",
].join(".");

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "autodl-tui-create-"));
  process.env.AUTODL_CONFIG_DIR = configDir;
  create.mockClear();
});

afterEach(async () => {
  delete process.env.AUTODL_CONFIG_DIR;
  await rm(configDir, { recursive: true, force: true });
});

const defaultIndex = Math.max(
  0,
  BASE_IMAGES.findIndex((image) => image.uuid === DEFAULT_BASE_IMAGE),
);

/** Steps down the image list to the first one whose CUDA differs from the default's. */
const stepsToADifferentCuda = (): number => {
  const from = BASE_IMAGES[defaultIndex];
  for (let step = 1; step < BASE_IMAGES.length; step += 1) {
    const candidate = BASE_IMAGES[(defaultIndex + step) % BASE_IMAGES.length];
    if (candidate && from && candidate.cuda !== from.cuda) return step;
  }
  throw new Error("every base image advertises the same CUDA version");
};

describe("the create wizard's payload", () => {
  it("sends the CUDA version of the image the user picked", async () => {
    const steps = stepsToADifferentCuda();
    const { stdin } = render(
      <App client={{} as never} token={TOKEN} tokenSource="config" onLogout={vi.fn()} />,
    );
    await flush();

    stdin.write(ENTER); // open the detail screen, which owns the create key
    await flush();
    stdin.write("n"); // open the wizard
    await flush();
    stdin.write(ENTER); // accept the GPU
    await flush();
    for (let i = 0; i < steps; i += 1) stdin.write("j"); // move off the default image
    await flush();
    stdin.write(ENTER); // accept the image
    await flush();
    stdin.write(ENTER); // accept the TTL
    await flush();
    stdin.write(ENTER); // confirm
    await flush();

    expect(create).toHaveBeenCalledTimes(1);
    const payload = create.mock.calls[0]?.[1] as CreatePayload;
    const chosen = BASE_IMAGES.find((image) => image.uuid === payload.imageUuid);

    expect(chosen).toBeDefined();
    // The invariant: the version sent describes the image sent alongside it.
    expect(payload.cudaFrom).toBe(parseCudaVersion(chosen?.cuda ?? "0"));
    expect(payload.cudaFrom).not.toBe(parseCudaVersion("11.8"));
  });

  it("arms no shutdown timer and tracks no TTL when 不限时 is chosen", async () => {
    const { stdin, lastFrame } = render(
      <App client={{} as never} token={TOKEN} tokenSource="config" onLogout={vi.fn()} />,
    );
    await flush();

    stdin.write(ENTER); // detail
    await flush();
    stdin.write("n"); // wizard
    await flush();
    stdin.write(ENTER); // accept the GPU
    await flush();
    stdin.write(ENTER); // accept the image
    await flush();
    for (let i = 0; i < 10 && !lastFrame()?.includes("› 不限时"); i += 1) {
      stdin.write("j");
      await flush();
    }
    expect(lastFrame()).toContain("不会自动关机");
    stdin.write(ENTER); // accept the TTL
    await flush();
    stdin.write(ENTER); // confirm
    await flush();

    expect(create).toHaveBeenCalledTimes(1);
    const payload = create.mock.calls[0]?.[1] as { startCommand?: string };
    expect(payload.startCommand).toBeUndefined();
    expect(listTracked()).toEqual([]);
  });

  it("offers only finished private images, sent with the CLI's default CUDA floor", async () => {
    // The image list carries no CUDA version; `autodl create --image <private>` assumes
    // 11.8, and the wizard prints that command as its equivalent.
    const { stdin, lastFrame } = render(
      <App client={{} as never} token={TOKEN} tokenSource="config" onLogout={vi.fn()} />,
    );
    await flush();

    stdin.write(ENTER); // detail
    await flush();
    stdin.write("n"); // wizard
    await flush();
    stdin.write(ENTER); // accept the GPU
    await flush();
    for (let i = 0; i < 20 && !lastFrame()?.includes("› 私有  my-env"); i += 1) {
      stdin.write("k");
      await flush();
    }
    // The cursor sits at the top, where an unfinished save would be listed beside it.
    expect(lastFrame()).not.toContain("image-saving");
    stdin.write(ENTER); // accept the image
    await flush();
    stdin.write(ENTER); // accept the TTL
    await flush();
    expect(lastFrame()).toContain("--image image-mine");
    stdin.write(ENTER); // confirm
    await flush();

    expect(create).toHaveBeenCalledTimes(1);
    const payload = create.mock.calls[0]?.[1] as CreatePayload;
    expect(payload.imageUuid).toBe("image-mine");
    expect(payload.cudaFrom).toBe(parseCudaVersion("11.8"));
  });
});
