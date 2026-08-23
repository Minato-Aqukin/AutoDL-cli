import { describe, expect, it } from "vitest";
import { AutoDLClient } from "../../src/core/client.js";
import {
  createInstance,
  findInstance,
  getInstanceSnapshot,
  listAllInstances,
  powerOffInstance,
  powerOnInstance,
  releaseInstance,
} from "../../src/core/endpoints/instance.js";
import { NotFoundError, UsageError } from "../../src/core/errors.js";
import { mockFetch } from "../fixtures/mock-fetch.js";
import {
  badRegionResponse,
  createResponse,
  emptySuccess,
  instanceListResponse,
  noStockResponse,
  sampleInstanceRaw,
  snapshotResponse,
} from "../fixtures/responses.js";

const LIST = "/api/v1/dev/instance/pro/list";
const CREATE = "/api/v1/dev/instance/pro/create";
const SNAPSHOT = "/api/v1/dev/instance/pro/snapshot";
const POWER_ON = "/api/v1/dev/instance/pro/power_on";
const POWER_OFF = "/api/v1/dev/instance/pro/power_off";
const RELEASE = "/api/v1/dev/instance/pro/release";

function client(fetchImpl: typeof fetch) {
  return new AutoDLClient({ token: "t", fetchImpl, retryBaseDelayMs: 1 });
}

const validInput = {
  gpuSpec: "pro6000-p",
  gpuNum: 1,
  imageUuid: "base-image-l2t43iu6uk",
  cudaFrom: 118,
};

describe("createInstance", () => {
  it("builds the documented payload and returns the new uuid", async () => {
    const fetchMock = mockFetch([{ path: CREATE, response: createResponse }]);
    const uuid = await createInstance(client(fetchMock.impl), {
      ...validInput,
      expandSystemDiskGb: 50,
      regions: ["westDC3", "beijingDC2"],
      name: "API创建的实例",
      startCommand: "sleep 1",
    });

    expect(uuid).toBe("pro-76419909953e");
    expect(fetchMock.callAt(0).body).toEqual({
      req_gpu_amount: 1,
      gpu_spec_uuid: "pro6000-p",
      image_uuid: "base-image-l2t43iu6uk",
      cuda_v_from: 118,
      expand_system_disk_by_gb: 50,
      data_center_list: ["westDC3", "beijingDC2"],
      instance_name: "API创建的实例",
      start_command: "sleep 1",
    });
  });

  it("omits optional fields rather than sending nulls", async () => {
    const fetchMock = mockFetch([{ path: CREATE, response: createResponse }]);
    await createInstance(client(fetchMock.impl), validInput);
    const body = fetchMock.callAt(0).body as Record<string, unknown>;
    expect(body).not.toHaveProperty("data_center_list");
    expect(body).not.toHaveProperty("instance_name");
    expect(body).not.toHaveProperty("start_command");
    expect(body.expand_system_disk_by_gb).toBe(0);
  });

  describe("input validation happens before any network call", () => {
    it.each([0, 5, 1.5, -1])("rejects gpuNum %s (AutoDL allows 1-4)", async (gpuNum) => {
      const fetchMock = mockFetch([{ path: CREATE, response: createResponse }]);
      await expect(
        createInstance(client(fetchMock.impl), { ...validInput, gpuNum }),
      ).rejects.toThrow(UsageError);
      expect(fetchMock.calls).toHaveLength(0);
    });

    it.each([-1, 501, 10.5])("rejects disk size %s GB (AutoDL allows 0-500)", async (disk) => {
      const fetchMock = mockFetch([{ path: CREATE, response: createResponse }]);
      await expect(
        createInstance(client(fetchMock.impl), { ...validInput, expandSystemDiskGb: disk }),
      ).rejects.toThrow(UsageError);
      expect(fetchMock.calls).toHaveLength(0);
    });

    it.each([1, 4, 2])("accepts gpuNum %s", async (gpuNum) => {
      const fetchMock = mockFetch([{ path: CREATE, response: createResponse }]);
      await expect(
        createInstance(client(fetchMock.impl), { ...validInput, gpuNum }),
      ).resolves.toBeDefined();
    });

    it("requires an image", async () => {
      const fetchMock = mockFetch([{ path: CREATE, response: createResponse }]);
      await expect(
        createInstance(client(fetchMock.impl), { ...validInput, imageUuid: "" }),
      ).rejects.toThrow(UsageError);
    });
  });
});

describe("listAllInstances", () => {
  it("normalises the documented list response", async () => {
    const fetchMock = mockFetch([{ path: LIST, response: instanceListResponse }]);
    const instances = await listAllInstances(client(fetchMock.impl));
    expect(instances).toHaveLength(1);
    expect(instances.at(0)?.uuid).toBe("pro-76576c61fdf1");
    expect(instances.at(0)?.status).toBe("running");
  });

  it("walks every page so callers never handle pagination", async () => {
    const page = (index: number, maxPage: number) => ({
      code: "Success",
      msg: "",
      data: {
        list: [{ ...sampleInstanceRaw, uuid: `pro-page-${index}` }],
        page_index: index,
        max_page: maxPage,
        result_total: maxPage,
      },
    });
    const fetchMock = mockFetch([{ path: LIST, response: (_call, i) => page(i + 1, 3) }]);
    const instances = await listAllInstances(client(fetchMock.impl));
    expect(instances.map((i) => i.uuid)).toEqual(["pro-page-1", "pro-page-2", "pro-page-3"]);
  });

  it("handles an account with no instances", async () => {
    const fetchMock = mockFetch([
      { path: LIST, response: { code: "Success", msg: "", data: { list: [], max_page: 1 } } },
    ]);
    await expect(listAllInstances(client(fetchMock.impl))).resolves.toEqual([]);
  });
});

describe("findInstance", () => {
  it("returns a NOT_FOUND error (exit 4) for an unknown id", async () => {
    const fetchMock = mockFetch([{ path: LIST, response: instanceListResponse }]);
    await expect(findInstance(client(fetchMock.impl), "pro-nope")).rejects.toThrow(NotFoundError);
  });
});

describe("power operations", () => {
  it("always sends payload:gpu — the open API has no CPU-only boot", async () => {
    const fetchMock = mockFetch([{ path: POWER_ON, response: emptySuccess }]);
    await powerOnInstance(client(fetchMock.impl), "pro-1");
    expect(fetchMock.callAt(0).body).toEqual({ instance_uuid: "pro-1", payload: "gpu" });
  });

  it("forwards a start command when given", async () => {
    const fetchMock = mockFetch([{ path: POWER_ON, response: emptySuccess }]);
    await powerOnInstance(client(fetchMock.impl), "pro-1", { startCommand: "echo hi" });
    expect(fetchMock.callAt(0).body).toMatchObject({ start_command: "echo hi" });
  });

  it("powers off with just the uuid", async () => {
    const fetchMock = mockFetch([{ path: POWER_OFF, response: emptySuccess }]);
    await powerOffInstance(client(fetchMock.impl), "pro-1");
    expect(fetchMock.callAt(0).body).toEqual({ instance_uuid: "pro-1" });
  });

  it("never retries release, which is irreversible", async () => {
    const fetchMock = mockFetch([{ path: RELEASE, status: 500, response: {} }]);
    await expect(releaseInstance(client(fetchMock.impl), "pro-1")).rejects.toThrow();
    expect(fetchMock.calls).toHaveLength(1);
  });
});

describe("real API error replies", () => {
  it("does not retry a rejected region — it will never start working", async () => {
    const fetchMock = mockFetch([{ path: CREATE, response: badRegionResponse }]);
    await expect(createInstance(client(fetchMock.impl), validInput)).rejects.toThrow(
      /请求参数错误/,
    );
    expect(fetchMock.calls).toHaveLength(1);
  });

  it("surfaces no-stock with the hint that the API cannot query capacity", async () => {
    const fetchMock = mockFetch([{ path: CREATE, response: noStockResponse }]);
    await expect(createInstance(client(fetchMock.impl), validInput)).rejects.toMatchObject({
      code: "NO_STOCK",
      exitCode: 6,
    });
  });
});

describe("getInstanceSnapshot", () => {
  it("returns live SSH credentials", async () => {
    const fetchMock = mockFetch([{ path: SNAPSHOT, response: snapshotResponse }]);
    const snapshot = await getInstanceSnapshot(client(fetchMock.impl), "pro-1");
    expect(snapshot.ssh).toMatchObject({
      host: "connect.xxx.autodl.com",
      port: 34222,
      password: "jbeOXgTWUxq+",
    });
    expect(snapshot.priceYuanPerHour).toBe(1.97);
  });
});
