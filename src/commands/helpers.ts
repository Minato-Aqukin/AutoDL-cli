import { confirm, isCancel } from "@clack/prompts";
import type { Command } from "commander";
import {
  type Context,
  createContext,
  type GlobalOptions,
  runOpportunisticSweep,
} from "../context.js";
import { type AutoDLError, ExitCode, toAutoDLError, UsageError } from "../core/errors.js";
import { configureOutput, emitError, isJson } from "../output/format.js";
import { resolveLang, setLang } from "../output/i18n.js";

/** Merge commander's per-command options with the root-level globals. */
export function globalsOf(command: Command): GlobalOptions {
  let root: Command = command;
  while (root.parent) root = root.parent;
  return root.opts<GlobalOptions>();
}

/**
 * Wrap a command body so every failure becomes a printed error plus the exit code an
 * agent can branch on. Nothing below this should ever call process.exit directly.
 */
export function action<Args extends unknown[]>(
  handler: (context: Context, ...args: Args) => Promise<number | undefined>,
  { sweep = true }: { sweep?: boolean } = {},
) {
  return async (...args: Args): Promise<void> => {
    const command = args[args.length - 1] as Command;
    const globals = globalsOf(command);
    try {
      const context = createContext(globals);
      if (sweep) await runOpportunisticSweep(context, globals);
      const code = await handler(context, ...args);
      process.exitCode = typeof code === "number" ? code : ExitCode.OK;
    } catch (err) {
      const error = toAutoDLError(err);
      emitError(error);
      process.exitCode = error.exitCode;
    }
  };
}

/**
 * Wrapper for commands that may not need the API at all — catalogue lookups, the local
 * TTL ledger. The context (and therefore the token requirement) is created lazily, so
 * `autodl gpus` works before you have ever logged in, while a command that does reach
 * the API still gets the same client and the same opportunistic sweep.
 */
export function lazyAction<Args extends unknown[]>(
  handler: (getContext: () => Context, ...args: Args) => Promise<number | undefined>,
) {
  return async (...args: Args): Promise<void> => {
    const command = args[args.length - 1] as Command;
    const globals = globalsOf(command);
    try {
      let context: Context | undefined;
      const getContext = (): Context => {
        if (!context) context = createContext(globals);
        return context;
      };
      // Output and language must be configured even when no client is built.
      configureOutput({
        json: globals.json ?? false,
        color: globals.color ?? true,
        verbose: globals.verbose ?? false,
      });
      setLang(resolveLang(globals.lang));

      const code = await handler(getContext, ...args);
      if (context) await runOpportunisticSweep(context, globals);
      process.exitCode = typeof code === "number" ? code : ExitCode.OK;
    } catch (err) {
      const error = toAutoDLError(err);
      emitError(error);
      process.exitCode = error.exitCode;
    }
  };
}

/**
 * Same wrapper for commands that must run without a token (login) — they build their
 * own context or none at all.
 */
export function bareAction<Args extends unknown[]>(
  handler: (globals: GlobalOptions, ...args: Args) => Promise<number | undefined>,
) {
  return async (...args: Args): Promise<void> => {
    const command = args[args.length - 1] as Command;
    const globals = globalsOf(command);
    try {
      const code = await handler(globals, ...args);
      process.exitCode = typeof code === "number" ? code : ExitCode.OK;
    } catch (err) {
      const error = toAutoDLError(err);
      emitError(error);
      process.exitCode = error.exitCode;
    }
  };
}

/**
 * Ask before something irreversible.
 *
 * In `--json` mode (i.e. an agent is driving) there is nobody to answer, so we refuse
 * rather than block or silently proceed — `--yes` is the explicit opt-in.
 */
export async function confirmDestructive(message: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (isJson() || !process.stdin.isTTY) {
    throw new UsageError(`${message}：需要显式确认`, {
      hint: "非交互模式下请加 --yes 明确确认这项不可逆操作。",
    });
  }
  const answer = await confirm({ message });
  if (isCancel(answer)) return false;
  return answer === true;
}

export function parsePositiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new UsageError(`${name} 必须是非负整数，收到 "${value}"`);
  }
  return parsed;
}

export function assertNoError(condition: boolean, error: AutoDLError): void {
  if (!condition) throw error;
}
