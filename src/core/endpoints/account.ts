import type { AutoDLClient } from "../client.js";
import { type Balance, normalizeBalance } from "../schemas.js";

/** Wallet balance, lifetime spend and voucher balance — the only account endpoint AutoDL exposes. */
export async function getBalance(client: AutoDLClient): Promise<Balance> {
  const data = await client.post<unknown>("/api/v1/dev/wallet/balance", {});
  return normalizeBalance(data);
}

/**
 * Mount or unmount the exclusive NFS / file storage for a region.
 * `mountable` is AutoDL's own 1 / -1 convention.
 */
export async function setNfsMount(
  client: AutoDLClient,
  dataCenter: string,
  mount: boolean,
): Promise<void> {
  await client.post("/api/v1/dev/exclusive_nfs/mount", {
    data_center: dataCenter,
    mountable: mount ? 1 : -1,
  });
}
