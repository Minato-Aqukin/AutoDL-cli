import type { Command } from "commander";
import pc from "picocolors";
import { parseDuration } from "../core/duration.js";
import { emit, formatBytes, isJson, note, printKeyValues, success } from "../output/format.js";
import { connectInteractive } from "../ssh/connect.js";
import { getCredentials } from "../ssh/credentials.js";
import { execCommand } from "../ssh/exec.js";
import { pull, push } from "../ssh/transfer.js";
import { action } from "./helpers.js";

export function registerSSHCommands(program: Command): void {
  program
    .command("ssh <id>")
    .description("交互式 SSH 登录实例")
    .option("--start", "实例未运行时自动开机", false)
    .option("--print", "只打印连接信息，不建立连接", false)
    .allowUnknownOption()
    .action(
      action(async (context, id: string, options: { start: boolean; print: boolean }, command) => {
        if (options.print) {
          const creds = await getCredentials(context.client, id, { autoStart: options.start });
          emit(creds, () => {
            printKeyValues([
              ["命令", `ssh -p ${creds.port} ${creds.user}@${creds.host}`],
              ["密码", creds.password],
            ]);
          });
          return 0;
        }

        // Anything commander didn't recognise is forwarded to the ssh binary, so
        // `autodl ssh <id> -L 8888:localhost:8888` works as expected.
        const extraArgs = (command as Command).args.slice(1);
        return connectInteractive(context.client, id, {
          autoStart: options.start,
          extraArgs,
        });
      }),
    );

  program
    .command("exec <id> <command...>")
    .description("在实例上执行命令，流式回传输出，透传远程退出码")
    .option("--start", "实例未运行时自动开机", false)
    .option("--cwd <dir>", "远程工作目录")
    .option("--timeout <duration>", "命令超时时间，如 30m")
    .option("--env <key=value...>", "注入环境变量")
    .option("--pty", "分配伪终端（需要 isatty 的程序用得上）", false)
    .action(
      action(
        async (
          context,
          id: string,
          commandParts: string[],
          options: {
            start: boolean;
            cwd?: string;
            timeout?: string;
            env?: string[];
            pty: boolean;
          },
        ) => {
          const remoteCommand = commandParts.join(" ");
          const env: Record<string, string> = {};
          for (const pair of options.env ?? []) {
            const index = pair.indexOf("=");
            if (index > 0) env[pair.slice(0, index)] = pair.slice(index + 1);
          }

          const result = await execCommand(context.client, id, remoteCommand, {
            autoStart: options.start,
            capture: true,
            // Humans expect `autodl exec box "cat f" > out.txt` to work, so remote
            // stdout goes to stdout. In --json mode (and under MCP, which sets it)
            // stdout is reserved for the payload, so it is diverted to stderr.
            stdout: isJson() ? process.stderr : process.stdout,
            stderr: process.stderr,
            pty: options.pty,
            ...(options.cwd ? { cwd: options.cwd } : {}),
            ...(Object.keys(env).length ? { env } : {}),
            ...(options.timeout ? { timeoutMs: parseDuration(options.timeout) * 1000 } : {}),
          });

          emit(
            {
              uuid: id,
              command: remoteCommand,
              exitCode: result.exitCode,
              signal: result.signal,
              stdout: result.stdout,
              stderr: result.stderr,
            },
            () => {},
          );
          // Propagate the remote exit code so `autodl exec ... && next` behaves.
          return result.exitCode ?? 1;
        },
      ),
    );

  program
    .command("push <id> <local> [remote]")
    .description("上传文件或目录到实例（SFTP）")
    .option("--start", "实例未运行时自动开机", false)
    .option("--ignore <pattern...>", "额外忽略的路径模式")
    .action(
      action(
        async (
          context,
          id: string,
          local: string,
          remote: string | undefined,
          options: { start: boolean; ignore?: string[] },
        ) => {
          const target = remote ?? "/root/autodl-tmp/autodl-cli";
          const summary = await push(context.client, id, local, target, {
            autoStart: options.start,
            ...(options.ignore ? { ignore: options.ignore } : {}),
            onProgress: ({ file, index, total }) => note(pc.dim(`↑ [${index}/${total}] ${file}`)),
          });
          emit({ uuid: id, local, remote: target, ...summary }, () =>
            success(`已上传 ${summary.files} 个文件（${formatBytes(summary.bytes)}）到 ${target}`),
          );
          return 0;
        },
      ),
    );

  program
    .command("pull <id> <remote> [local]")
    .description("从实例下载文件或目录（SFTP）")
    .option("--start", "实例未运行时自动开机", false)
    .action(
      action(
        async (
          context,
          id: string,
          remote: string,
          local: string | undefined,
          options: { start: boolean },
        ) => {
          const target = local ?? "./autodl-output";
          const summary = await pull(context.client, id, remote, target, {
            autoStart: options.start,
            onProgress: ({ file, index, total }) => note(pc.dim(`↓ [${index}/${total}] ${file}`)),
          });
          emit({ uuid: id, remote, local: target, ...summary }, () =>
            success(`已下载 ${summary.files} 个文件（${formatBytes(summary.bytes)}）到 ${target}`),
          );
          return 0;
        },
      ),
    );
}
