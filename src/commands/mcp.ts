import type { Command } from "commander";
import { toAutoDLError } from "../core/errors.js";
import { startMcpServer } from "../mcp/server.js";
import { globalsOf } from "./helpers.js";

export function registerMcpCommand(program: Command): void {
  program
    .command("mcp")
    .description("以 stdio MCP server 方式运行，供 Claude Code / Cursor / Cline 等 agent 调用")
    .action(async (_options: unknown, command: Command) => {
      const globals = globalsOf(command);
      try {
        await startMcpServer({
          ...(globals.token ? { token: globals.token } : {}),
          ...(globals.baseUrl ? { baseUrl: globals.baseUrl } : {}),
        });
      } catch (err) {
        const error = toAutoDLError(err);
        // stdout is the MCP channel — diagnostics must never contaminate it.
        process.stderr.write(`${error.message}\n`);
        if (error.hint) process.stderr.write(`${error.hint}\n`);
        process.exitCode = error.exitCode;
      }
    });
}
