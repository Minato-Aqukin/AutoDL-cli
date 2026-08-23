import type { Command } from "commander";
import { createContext } from "../context.js";
import { UsageError } from "../core/errors.js";
import { bareAction, globalsOf } from "./helpers.js";

/**
 * Refuse the TUI wherever a full-screen app would be wrong or harmful.
 *
 * `--json` and non-TTY are the CLI's agent contract: stdout must stay parseable and
 * nothing may take over the terminal. Failing loudly beats silently degrading, because
 * a script that lands here has a bug worth seeing.
 */
export function assertInteractive(json: boolean): void {
  if (json) {
    throw new UsageError("TUI 是交互式界面，不能与 --json 一起使用", {
      hint: "需要机器可读输出请用 `autodl ls --json` 等命令。",
    });
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new UsageError("当前不是交互式终端，无法启动 TUI", {
      hint: "TUI 需要真实终端。在管道、CI 或 agent 调用中请使用普通子命令。",
    });
  }
}

/** Load the TUI lazily so `mcp` / `ls` / `exec` never parse the Ink bundle. */
export async function launchTui(globals: {
  token?: string;
  baseUrl?: string;
  json?: boolean;
}): Promise<void> {
  assertInteractive(globals.json === true);
  const context = createContext({
    ...(globals.token ? { token: globals.token } : {}),
    ...(globals.baseUrl ? { baseUrl: globals.baseUrl } : {}),
  });
  const { runTui } = await import("../tui/app.js");
  await runTui(context.client);
}

export function registerTuiCommand(program: Command): void {
  program
    .command("tui")
    .description("启动交互式看板（实例、费用、库存、创建）")
    .action(
      bareAction(async (_globals, _options: unknown, command: Command) => {
        await launchTui(globalsOf(command));
        return 0;
      }),
    );
}
