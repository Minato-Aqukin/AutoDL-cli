import { intro, isCancel, outro, password, spinner } from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { clearToken, configPath, readConfig, updateConfig } from "../config/store.js";
import { createContext } from "../context.js";
import { AutoDLClient, redactToken } from "../core/client.js";
import { getBalance } from "../core/endpoints/account.js";
import { UsageError } from "../core/errors.js";
import { formatYuan } from "../core/money.js";
import { configureOutput, emit, isJson, printKeyValues, success } from "../output/format.js";
import { resolveLang, setLang, t } from "../output/i18n.js";
import { action, bareAction } from "./helpers.js";

export function registerAuthCommands(program: Command): void {
  program
    .command("login")
    .description("配置 AutoDL 开发者 Token")
    .option("--token <token>", "直接提供 Token，跳过交互式输入")
    .action(
      bareAction(async (globals, options: { token?: string }) => {
        setLang(resolveLang(globals.lang));
        configureOutput({ json: globals.json ?? false, color: globals.color ?? true });

        let token = options.token ?? globals.token;

        if (!token) {
          if (isJson() || !process.stdin.isTTY) {
            throw new UsageError("非交互环境下必须通过 --token 提供 Token", {
              hint: "例如：autodl login --token <你的Token>，或直接设置 AUTODL_TOKEN 环境变量。",
            });
          }
          intro(pc.bold("AutoDL 登录"));
          const answer = await password({
            message: `${t("login.prompt")}\n  ${pc.dim(t("login.hint"))}`,
          });
          if (isCancel(answer)) {
            outro(t("login.cancelled"));
            return 0;
          }
          token = String(answer);
        }

        // Verify before persisting — writing a dead token just moves the failure later.
        const spin = isJson() ? null : spinner();
        spin?.start(t("login.verifying"));
        const client = new AutoDLClient({ token });
        let balance: Awaited<ReturnType<typeof getBalance>>;
        try {
          balance = await getBalance(client);
        } catch (err) {
          spin?.stop("验证失败", 1);
          throw err;
        }
        spin?.stop("Token 有效");

        updateConfig({ token });

        emit(
          {
            saved: true,
            configPath: configPath(),
            token: redactToken(token),
            balanceYuan: balance.balanceYuan,
          },
          () => {
            success(`${t("login.success")} ${configPath()}`);
            printKeyValues([
              [t("account.balance"), formatYuan(balance.balanceYuan)],
              ["Token", redactToken(token as string)],
            ]);
          },
        );
        return 0;
      }),
    );

  program
    .command("logout")
    .description("清除本地保存的 Token")
    .action(
      bareAction(async (globals) => {
        setLang(resolveLang(globals.lang));
        configureOutput({ json: globals.json ?? false, color: globals.color ?? true });
        clearToken();
        emit({ cleared: true, configPath: configPath() }, () => success(t("logout.done")));
        return 0;
      }),
    );

  program
    .command("whoami")
    .description("显示当前 Token 来源与账号可用余额")
    .action(
      action(
        async (context) => {
          const balance = await getBalance(context.client);
          const stored = readConfig().token;
          const source = process.env.AUTODL_TOKEN
            ? "env:AUTODL_TOKEN"
            : stored
              ? `config:${configPath()}`
              : "flag";
          emit({ tokenSource: source, token: context.client.maskedToken, ...balance }, () => {
            printKeyValues([
              ["Token", context.client.maskedToken],
              ["来源", source],
              [t("account.balance"), formatYuan(balance.balanceYuan)],
            ]);
          });
          return 0;
        },
        { sweep: false },
      ),
    );
}

export { createContext };
