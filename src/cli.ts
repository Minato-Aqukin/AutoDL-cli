import { Command } from "commander";
import { registerAccountCommands } from "./commands/account.js";
import { registerAuthCommands } from "./commands/auth.js";
import { registerCatalogCommands } from "./commands/catalog.js";
import { registerGuardCommands } from "./commands/guard.js";
import { registerInstanceCommands } from "./commands/instances.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { registerRunCommand } from "./commands/run.js";
import { registerSSHCommands } from "./commands/ssh.js";
import { ExitCode, toAutoDLError } from "./core/errors.js";
import { emitError } from "./output/format.js";

const VERSION = "0.1.0";

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
  registerRunCommand(program);
  registerGuardCommands(program);
  registerCatalogCommands(program);
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
      "    --sync ./ --pull /root/autodl-cli/out          跑完自动关机",
      "  autodl ls --json | jq '.data[].uuid'            供脚本与 agent 消费",
      "",
      "接入 agent（Claude Code）：",
      "  claude mcp add autodl -- npx -y @minatoaqukin/autodl-cli mcp",
    ].join("\n"),
  );

  return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    // Commander throws for --help / --version; those already printed their output.
    const asCommanderError = err as { code?: string; exitCode?: number };
    if (
      typeof asCommanderError?.code === "string" &&
      asCommanderError.code.startsWith("commander.")
    ) {
      process.exitCode = asCommanderError.exitCode ?? ExitCode.OK;
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
