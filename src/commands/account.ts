import type { Command } from "commander";
import { getBalance } from "../core/endpoints/account.js";
import { formatYuan } from "../core/money.js";
import { emit, printKeyValues } from "../output/format.js";
import { t } from "../output/i18n.js";
import { action } from "./helpers.js";

export function registerAccountCommands(program: Command): void {
  program
    .command("account")
    .alias("balance")
    .description("查看账号余额、累计消费与代金券")
    .action(
      action(async (context) => {
        const balance = await getBalance(context.client);
        emit({ ...balance, spendableYuan: balance.balanceYuan + balance.voucherYuan }, () => {
          printKeyValues([
            [t("account.balance"), formatYuan(balance.balanceYuan)],
            [t("account.voucher"), formatYuan(balance.voucherYuan)],
            [t("account.accumulated"), formatYuan(balance.accumulatedYuan)],
          ]);
        });
        return 0;
      }),
    );
}
