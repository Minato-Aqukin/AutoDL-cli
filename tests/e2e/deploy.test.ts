import { afterAll, describe, expect, it } from "vitest";
import { AutoDLClient } from "../../src/core/client.js";
import {
  getInstanceStatus,
  listAllInstances,
  powerOffInstance,
  releaseInstance,
} from "../../src/core/endpoints/instance.js";
import { getStockByRegion } from "../../src/core/stock.js";
import { waitForShutdown } from "../../src/core/waiters.js";
import { execCommand } from "../../src/ssh/exec.js";
import { deployWorkflow } from "../../src/workflow/deploy.js";

/**
 * Real deploy run against AutoDL. RENTS A REAL GPU AND COSTS REAL MONEY (~¥0.2).
 *
 *   AUTODL_E2E=1 AUTODL_TOKEN=<token> npm run test:e2e
 *
 * The assertion that matters most is that the instance ends up **shutdown, not
 * released** — that is the entire difference between `deploy` and `run`, and no mock
 * can prove AutoDL actually preserved the disks.
 */

const enabled = process.env.AUTODL_E2E === "1" && Boolean(process.env.AUTODL_TOKEN);
const describeE2E = enabled ? describe : describe.skip;

const GPU = process.env.AUTODL_E2E_GPU ?? "4090D";
// Tiny public repo: a clone is a couple of KB, so this measures the workflow, not I/O.
const REPO = process.env.AUTODL_E2E_REPO ?? "octocat/Hello-World";
const DIR = "/root/autodl-tmp/Hello-World";

const client = new AutoDLClient({ token: process.env.AUTODL_TOKEN ?? "placeholder" });
let instanceUuid: string | undefined;

afterAll(async () => {
  if (!instanceUuid) return;
  try {
    const status = await getInstanceStatus(client, instanceUuid);
    if (status !== "shutdown") await powerOffInstance(client, instanceUuid);
    await waitForShutdown(client, instanceUuid, { timeoutMs: 5 * 60_000 }).catch(() => {});
    await releaseInstance(client, instanceUuid);
  } catch (err) {
    console.error(`清理失败，请手动检查实例 ${instanceUuid}：${(err as Error).message}`);
  }
}, 10 * 60_000);

describeE2E("deploy (real API, real money)", () => {
  it("reports GPU stock that looks plausible", async () => {
    const { snapshots } = await getStockByRegion(client, { regions: ["westDC3"] });
    expect(snapshots).toHaveLength(1);
    const entries = snapshots[0]?.entries ?? [];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.idle).toBeLessThanOrEqual(entry.total);
    }
  });

  it(
    "creates an instance, clones the repo to the data disk, and runs it",
    async () => {
      const result = await deployWorkflow(client, {
        repo: REPO,
        gpu: GPU,
        ttlSeconds: 1800,
        start: "cat README",
      });
      instanceUuid = result.instanceUuid;

      expect(result.created).toBe(true);
      expect(result.dir).toBe(DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Hello World");
      // No manifest in this repo, so detection should come back empty rather than guess.
      expect(result.setupCommand).toBeNull();
    },
    15 * 60_000,
  );

  it("leaves the instance SHUTDOWN rather than released", async () => {
    // The core requirement. A released instance would not appear in the list at all.
    const instances = await listAllInstances(client);
    const found = instances.find((instance) => instance.uuid === instanceUuid);
    expect(found, "实例应当仍然存在（关机而非释放）").toBeDefined();
    expect(found?.status).toBe("shutdown");
  });

  it(
    "reuses the stopped instance, proving the data disk survived the power cycle",
    async () => {
      // Write a manifest while the box is up, so the redeploy has something to detect.
      const seed = await execCommand(
        client,
        instanceUuid as string,
        `mkdir -p ${DIR} && echo six > ${DIR}/requirements.txt`,
        { autoStart: true, capture: true },
      );
      expect(seed.exitCode).toBe(0);

      const result = await deployWorkflow(client, {
        repo: REPO,
        instanceUuid,
        ttlSeconds: 1800,
        start: "cat README",
      });

      expect(result.created).toBe(false);
      expect(result.instanceUuid).toBe(instanceUuid);
      // The file written before the power cycle is still there, and got detected.
      expect(result.setupCommand).toBe("pip install -r requirements.txt");
      expect(result.exitCode).toBe(0);
    },
    20 * 60_000,
  );
});
