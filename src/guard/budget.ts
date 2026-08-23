import { readConfig } from "../config/store.js";
import type { AutoDLClient } from "../core/client.js";
import { getBalance } from "../core/endpoints/account.js";
import { BudgetError } from "../core/errors.js";
import { formatYuan } from "../core/money.js";
import { debug } from "../output/format.js";

/** Below this, renting anything is likely to fail or strand a half-configured box. */
export const DEFAULT_MIN_BALANCE_YUAN = 5;

export function resolveMinBalance(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const fromEnv = Number(process.env.AUTODL_MIN_BALANCE);
  if (!Number.isNaN(fromEnv) && process.env.AUTODL_MIN_BALANCE) return fromEnv;
  return readConfig().defaults?.minBalanceYuan ?? DEFAULT_MIN_BALANCE_YUAN;
}

/**
 * Refuse to create an instance when the wallet is nearly empty.
 *
 * AutoDL doesn't reclaim instances the moment the balance hits zero — it keeps them
 * around to protect data — so a low balance turns into a stuck, unusable instance
 * rather than a clean failure. Better to stop before renting.
 */
export async function assertBudget(client: AutoDLClient, minYuan?: number): Promise<number> {
  const threshold = resolveMinBalance(minYuan);
  if (threshold <= 0) {
    debug("余额闸门已禁用（阈值 <= 0）");
    return Number.POSITIVE_INFINITY;
  }

  const balance = await getBalance(client);
  const spendable = balance.balanceYuan + balance.voucherYuan;
  debug(`余额检查：可用 ${formatYuan(spendable)}，阈值 ${formatYuan(threshold)}`);

  if (spendable < threshold) {
    throw new BudgetError(
      `账号可用余额 ${formatYuan(spendable)} 低于阈值 ${formatYuan(threshold)}，已阻止创建实例`,
      {
        code: "INSUFFICIENT_BALANCE",
        hint: "先充值，或用 --min-balance 0 显式跳过这道闸门。",
        details: { spendableYuan: spendable, thresholdYuan: threshold },
      },
    );
  }
  return spendable;
}
