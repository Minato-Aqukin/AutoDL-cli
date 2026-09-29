#!/usr/bin/env node
import { Command } from "commander";
import { registerAccountCommands } from "./commands/account.js";
import { registerAuthCommands } from "./commands/auth.js";
import { registerCatalogCommands } from "./commands/catalog.js";
import { registerDeployCommand } from "./commands/deploy.js";
import { registerFileCommands } from "./commands/files.js";
import { registerGuardCommands } from "./commands/guard.js";
import { registerInstanceCommands } from "./commands/instances.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { registerRunCommand } from "./commands/run.js";
import { registerSSHCommands } from "./commands/ssh.js";
import { registerStockCommand } from "./commands/stock.js";
import { registerTuiCommand } from "./commands/tui.js";
import type { GlobalOptions } from "./context.js";
import { ExitCode, toAutoDLError, UsageError } from "./core/errors.js";
import { configureOutput, emitError } from "./output/format.js";
import { VERSION } from "./version.js";

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("autodl")
    .description(
      [
        "AutoDL 实例管理命令行工具（非官方）。",
        "",
        "面向人和 agent 两种使用者：所有命令都支持 --json 输出与稳定退出码，",
        "`autodl mcp` 可直接作为 MCP server 接入 Claude Code / Cursor / Cline。",
      ].join("\n"),
    )
    .version(VERSION, "-v, --version")
    .option("--token <token>", "AutoDL 开发者 Token（优先级高于环境变量与配置文件）")
    .option("--base-url <url>", "API 基地址，默认 https://api.autodl.com")
    .option("--json", "以 JSON 输出到 stdout（人类可读信息走 stderr）", false)
    .option("--no-color", "禁用彩色输出")
    .option("--verbose", "输出调试信息", false)
    .option("--lang <lang>", "输出语言：zh / en")
    .option("--no-sweep", "跳过启动时的 TTL 超时实例自动清理")
    .showHelpAfterError("（运行 `autodl --help` 查看用法）");

  registerAuthCommands(program);
  registerAccountCommands(program);
  registerInstanceCommands(program);
  registerSSHCommands(program);
  registerFileCommands(program);
  registerRunCommand(program);
  registerDeployCommand(program);
  registerGuardCommands(program);
  registerCatalogCommands(program);
  registerStockCommand(program);
  registerTuiCommand(program);
  registerMcpCommand(program);

  program.addHelpText(
    "after",
    [
      "",
      "退出码：",
      "  0 成功   1 通用错误   2 参数错误   3 Token 无效   4 资源不存在",
      "  5 余额不足/被护栏拦截   6 GPU 无库存   7 超时   8 SSH 失败",
      "",
      "示例：",
      "  autodl login                                    配置开发者 Token",
      "  autodl create --gpu 4090 --ttl 2h --wait        创建实例并等待就绪",
      "  autodl exec pro-xxx 'nvidia-smi'                远程执行命令",
      "  autodl run 'python train.py' --gpu 4090 \\",
      "    --sync ./ --pull /root/autodl-tmp/autodl-cli/out   跑完自动关机",
      "  autodl ls --json | jq '.data[].uuid'            供脚本与 agent 消费",
      "",
      "接入 agent（Claude Code）：",
      "  claude mcp add autodl -- npx -y @minato-aqukin/autodl-cli mcp",
    ].join("\n"),
  );

  return program;
}

/**
 * Whether a bare `autodl` should open the dashboard.
 *
 * Deliberately narrow. A script that runs `autodl` with no arguments must keep getting
 * help on stdout exactly as before, so every one of these has to hold: no arguments, a
 * real terminal on both ends, and no --json anywhere on the line.
 */
export function shouldLaunchBareTui(argv: string[]): boolean {
  const args = argv.slice(2);
  if (args.length > 0) return false;
  if (!process.stdout.isTTY || !process.stdin.isTTY) return false;
  return true;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  if (shouldLaunchBareTui(argv)) {
    try {
      const { launchTui } = await import("./commands/tui.js");
      await launchTui({});
      return;
    } catch (err) {
      const error = toAutoDLError(err);
      emitError(error);
      process.exitCode = error.exitCode;
      return;
    }
  }

  const program = buildProgram();
  // Buffer commander's parse-phase diagnostics instead of letting them reach stderr
  // immediately, so --json can replace them with the single stdout envelope.
  // Human output is replayed verbatim below, so non-JSON behaviour is unchanged.
  const parseDiagnostics: string[] = [];
  const bufferDiagnostic = (message: string): void => {
    parseDiagnostics.push(message);
  };
  const installParseHandling = (command: Command): void => {
    // Subcommands snapshot the output config and exit callback at creation time,
    // so every level needs the same treatment as the root.
    command.configureOutput({ outputError: bufferDiagnostic, writeErr: bufferDiagnostic });
    // Turn commander's process.exit() into a catchable error so parse failures get
    // the documented exit codes and output routing instead of exit 1 + stderr text.
    command.exitOverride();
    for (const subcommand of command.commands) installParseHandling(subcommand);
  };
  installParseHandling(program);
  try {
    await program.parseAsync(argv);
  } catch (err) {
    const commanderError = err as { code?: string; exitCode?: number; message?: string };
    if (typeof commanderError?.code === "string" && commanderError.code.startsWith("commander.")) {
      // --help / --version already printed to stdout; keep exit 0.
      if (
        commanderError.code === "commander.helpDisplayed" ||
        commanderError.code === "commander.version"
      ) {
        process.exitCode = commanderError.exitCode ?? ExitCode.OK;
        return;
      }
      // program.opts() reflects commander's own parsing, so a --json that is an
      // option value (--token --json) or past -- is not mistaken for the flag.
      const jsonRequested = program.opts<GlobalOptions>().json === true;
      if (jsonRequested) {
        configureOutput({ json: true });
        emitError(
          new UsageError(
            commanderError.code === "commander.help"
              ? "未指定子命令"
              : (commanderError.message ?? "").replace(/^error:\s*/, ""),
            { hint: "运行 `autodl --help` 查看用法" },
          ),
        );
        process.exitCode = ExitCode.USAGE;
        return;
      }
      if (parseDiagnostics.length > 0) process.stderr.write(parseDiagnostics.join(""));
      process.exitCode =
        commanderError.code === "commander.help"
          ? (commanderError.exitCode ?? ExitCode.GENERIC)
          : ExitCode.USAGE;
      return;
    }
    const error = toAutoDLError(err);
    emitError(error);
    process.exitCode = error.exitCode;
  }
}

main().catch((err) => {
  const error = toAutoDLError(err);
  emitError(error);
  process.exitCode = error.exitCode;
});
