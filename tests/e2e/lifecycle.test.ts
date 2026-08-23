import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AutoDLClient } from "../../src/core/client.js";
import { getBalance } from "../../src/core/endpoints/account.js";
import {
  createInstance,
  getInstanceSnapshot,
  getInstanceStatus,
  powerOffInstance,
  powerOnInstance,
  releaseInstance,
} from "../../src/core/endpoints/instance.js";
import { waitForRunning, waitForShutdown } from "../../src/core/waiters.js";
import { composeStartCommand } from "../../src/guard/ttl.js";
import { execCommand } from "../../src/ssh/exec.js";
import { pull, push } from "../../src/ssh/transfer.js";

/**
 * Real end-to-end run against AutoDL. THIS RENTS A REAL GPU AND COSTS REAL MONEY
 * (a few jiao). Requires a developer token on an identity-verified account.
 *
 *   AUTODL_E2E=1 AUTODL_TOKEN=<token> npm run test:e2e
 *
 * Optional: AUTODL_E2E_GPU (default 4090D), AUTODL_E2E_RELEASE=1 to release at the end.
 *
 * The single most important assertion here is the power-cycle one: AutoDL rotates the
 * SSH port and root password on every stop/start, and no mock can prove we survive it.
 */

const enabled = process.env.AUTODL_E2E === "1" && Boolean(process.env.AUTODL_TOKEN);
const describeE2E = enabled ? describe : describe.skip;

const GPU = process.env.AUTODL_E2E_GPU ?? "4090D";
const TTL_SECONDS = 1800; // 30 min backstop in case this suite dies mid-run.

let instanceUuid: string | undefined;
const client = new AutoDLClient({ token: process.env.AUTODL_TOKEN ?? "placeholder" });

afterAll(async () => {
  // Never leave a GPU running, whatever happened above.
  if (!instanceUuid) return;
  try {
    const status = await getInstanceStatus(client, instanceUuid);
    if (status !== "shutdown") await powerOffInstance(client, instanceUuid);
    if (process.env.AUTODL_E2E_RELEASE === "1") {
      await waitForShutdown(client, instanceUuid, { timeoutMs: 5 * 60_000 });
      await releaseInstance(client, instanceUuid);
    } else {
      console.warn(`\n实例 ${instanceUuid} 已关机但未释放。释放：autodl rm ${instanceUuid} --yes`);
    }
  } catch (err) {
    console.error(`清理失败，请手动检查实例 ${instanceUuid}：${(err as Error).message}`);
  }
}, 10 * 60_000);

describeE2E("AutoDL lifecycle (real API, real money)", () => {
  it("reads the account balance", async () => {
    const balance = await getBalance(client);
    expect(balance.balanceYuan).toBeTypeOf("number");
    expect(balance.balanceYuan + balance.voucherYuan).toBeGreaterThan(1);
  });

  it("creates an instance with an in-instance shutdown timer", async () => {
    instanceUuid = await createInstance(client, {
      gpuSpec: GPU,
      gpuNum: 1,
      imageUuid: "base-image-l2t43iu6uk",
      cudaFrom: 118,
      expandSystemDiskGb: 0,
      name: "autodl-cli-e2e",
      startCommand: composeStartCommand(TTL_SECONDS, undefined) as string,
    });
    expect(instanceUuid).toMatch(/^pro-/);
  });

  it("reaches running state", async () => {
    expect(await waitForRunning(client, instanceUuid as string)).toBe("running");
  });

  it("runs a command over SSH", async () => {
    const result = await execCommand(client, instanceUuid as string, "nvidia-smi -L");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("GPU 0");
  });

  it("propagates a non-zero remote exit code", async () => {
    const result = await execCommand(client, instanceUuid as string, "exit 42");
    expect(result.exitCode).toBe(42);
  });

  it("round-trips a file over SFTP", async () => {
    const dir = await mkdtemp(join(tmpdir(), "autodl-e2e-"));
    try {
      await writeFile(join(dir, "hello.txt"), "from-local\n");
      await push(client, instanceUuid as string, join(dir, "hello.txt"), "/root/e2e/hello.txt", {
        noIgnoreFiles: true,
      });

      const remote = await execCommand(client, instanceUuid as string, "cat /root/e2e/hello.txt");
      expect(remote.stdout).toContain("from-local");

      await execCommand(client, instanceUuid as string, "echo from-remote > /root/e2e/back.txt");
      await pull(client, instanceUuid as string, "/root/e2e/back.txt", join(dir, "back.txt"));
      expect(await readFile(join(dir, "back.txt"), "utf8")).toContain("from-remote");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it(
    "survives a power cycle even though the SSH port and password both change",
    async () => {
      const before = await getInstanceSnapshot(client, instanceUuid as string);

      await powerOffInstance(client, instanceUuid as string);
      await waitForShutdown(client, instanceUuid as string, { timeoutMs: 10 * 60_000 });

      await powerOnInstance(client, instanceUuid as string, {
        startCommand: composeStartCommand(TTL_SECONDS, undefined) as string,
      });
      await waitForRunning(client, instanceUuid as string, { timeoutMs: 10 * 60_000 });

      const after = await getInstanceSnapshot(client, instanceUuid as string);
      // Not strictly guaranteed to differ, but this is the documented behaviour and
      // the whole reason credentials are never cached.
      console.warn(
        `端口 ${before.ssh.port} -> ${after.ssh.port}，密码是否变化：${before.ssh.password !== after.ssh.password}`,
      );

      // The real assertion: exec still works without the caller doing anything.
      const result = await execCommand(client, instanceUuid as string, "echo still-here");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("still-here");
    },
    20 * 60_000,
  );

  it("confirms the in-instance TTL timer is actually scheduled", async () => {
    const result = await execCommand(
      client,
      instanceUuid as string,
      "ps -eo args | grep -c '[s]leep' || true",
    );
    expect(Number(result.stdout.trim())).toBeGreaterThan(0);
  });
});
