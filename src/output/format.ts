import Table from "cli-table3";
import pc from "picocolors";
import type { AutoDLError } from "../core/errors.js";

/**
 * The output contract.
 *
 * In `--json` mode every command prints exactly one JSON object to stdout:
 *   success -> {"ok": true,  "data": ...}
 *   failure -> {"ok": false, "error": {"code", "message", "hint?", "requestId?"}}
 *
 * Human-readable chatter always goes to stderr so that `autodl ... --json | jq` works
 * even while a spinner is running. Agents can rely on stdout being pure JSON.
 */

export interface OutputOptions {
  json: boolean;
  color: boolean;
  verbose: boolean;
}

let options: OutputOptions = { json: false, color: true, verbose: false };

export function configureOutput(next: Partial<OutputOptions>): void {
  options = { ...options, ...next };
  if (!options.color) {
    // picocolors reads this on each call, so flipping it disables colour globally.
    process.env.NO_COLOR = "1";
  }
}

export const isJson = (): boolean => options.json;
export const isVerbose = (): boolean => options.verbose;

/** Status messages, prompts and progress — never stdout, so JSON stays parseable. */
export function note(message: string): void {
  if (options.json) return;
  process.stderr.write(`${message}\n`);
}

export function success(message: string): void {
  if (options.json) return;
  process.stderr.write(`${pc.green("✔")} ${message}\n`);
}

export function warn(message: string): void {
  if (options.json) return;
  process.stderr.write(`${pc.yellow("!")} ${message}\n`);
}

export function debug(message: string): void {
  if (!options.verbose) return;
  process.stderr.write(`${pc.dim(`[debug] ${message}`)}\n`);
}

/** Terminal output for a successful command. In JSON mode `data` is the payload. */
export function emit(data: unknown, renderHuman: () => void): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, data }, null, 2)}\n`);
    return;
  }
  renderHuman();
}

export function emitError(error: AutoDLError): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.toJSON() }, null, 2)}\n`);
    return;
  }
  process.stderr.write(`${pc.red("✖")} ${error.message}\n`);
  if (error.hint) process.stderr.write(`  ${pc.dim(error.hint)}\n`);
  if (error.requestId) process.stderr.write(`  ${pc.dim(`request_id: ${error.requestId}`)}\n`);
  if (options.verbose && error.cause instanceof Error && error.cause.stack) {
    process.stderr.write(`${pc.dim(error.cause.stack)}\n`);
  }
}

export function table(head: string[], rows: (string | number)[][]): string {
  const t = new Table({
    head: head.map((h) => pc.bold(h)),
    style: { head: [], border: [] },
    chars: {
      top: "─",
      "top-mid": "┬",
      "top-left": "┌",
      "top-right": "┐",
      bottom: "─",
      "bottom-mid": "┴",
      "bottom-left": "└",
      "bottom-right": "┘",
      left: "│",
      "left-mid": "├",
      mid: "─",
      "mid-mid": "┼",
      right: "│",
      "right-mid": "┤",
      middle: "│",
    },
  });
  for (const row of rows) t.push(row.map((cell) => String(cell)));
  return t.toString();
}

export function printTable(head: string[], rows: (string | number)[][]): void {
  process.stdout.write(`${table(head, rows)}\n`);
}

/** Key/value block used by `autodl info` and `autodl account`. */
export function printKeyValues(pairs: [string, string][]): void {
  const width = Math.max(...pairs.map(([key]) => stringWidth(key)));
  for (const [key, value] of pairs) {
    const pad = " ".repeat(Math.max(0, width - stringWidth(key)));
    process.stdout.write(`${pc.dim(key)}${pad}  ${value}\n`);
  }
}

/** CJK characters occupy two terminal columns; naive .length misaligns tables. */
export function stringWidth(input: string): number {
  let width = 0;
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    width +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
        ? 2
        : 1;
  }
  return width;
}

export function colorStatus(status: string): string {
  switch (status) {
    case "running":
      return pc.green(status);
    case "starting":
    case "creating":
      return pc.cyan(status);
    case "shutting_down":
    case "shutdown":
      return pc.dim(status);
    case "failed":
    case "released":
      return pc.red(status);
    default:
      return status;
  }
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)}${units[index]}`;
}

/** ISO timestamp -> local `MM-DD HH:mm`, or `-` when absent. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
