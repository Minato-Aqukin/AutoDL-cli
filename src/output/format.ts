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
  /**
   * Silence every human-facing writer.
   *
   * The TUI owns the screen: any stray write from a core helper — "正在开机…", a debug
   * line, a sweep warning — lands in the middle of the rendered frame and corrupts the
   * layout. Those messages are still surfaced, but through the status bar instead.
   */
  quiet: boolean;
}

let options: OutputOptions = { json: false, color: true, verbose: false, quiet: false };

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
  if (options.json || options.quiet) return;
  process.stderr.write(`${message}\n`);
}

export function success(message: string): void {
  if (options.json || options.quiet) return;
  process.stderr.write(`${pc.green("✔")} ${message}\n`);
}

export function warn(message: string): void {
  if (options.json || options.quiet) return;
  process.stderr.write(`${pc.yellow("!")} ${message}\n`);
}

export function debug(message: string): void {
  if (!options.verbose || options.quiet) return;
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

/** Box-drawn table: one-space padding, a rule under the header and between rows. */
export function table(head: string[], rows: (string | number)[][]): string {
  const lines = [head.map((h) => pc.bold(h)), ...rows.map((row) => row.map(String))].map((row) =>
    row.map((cell) => cell.split("\n")),
  );
  const columns = Math.max(0, ...lines.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.max(0, ...lines.flatMap((row) => (row[column] ?? [""]).map((line) => stringWidth(line)))),
  );
  const rule = (left: string, mid: string, right: string): string =>
    `${left}${widths.map((width) => "─".repeat(width + 2)).join(mid)}${right}`;
  const render = (row: string[][]): string[] => {
    const height = Math.max(1, ...row.map((cell) => cell.length));
    return Array.from({ length: height }, (_, index) => {
      const cells = widths.map((width, column) => {
        const text = row[column]?.[index] ?? "";
        return ` ${text}${" ".repeat(width - stringWidth(text))} `;
      });
      return `│${cells.join("│")}│`;
    });
  };
  const [header = [], ...body] = lines;
  return [
    rule("┌", "┬", "┐"),
    ...render(header),
    ...body.flatMap((row) => [rule("├", "┼", "┤"), ...render(row)]),
    rule("└", "┴", "┘"),
  ].join("\n");
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

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the point.
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const ZERO_WIDTH = /[\p{Mn}\p{Me}\p{Cf}]/u;
const EMOJI = /\p{Emoji_Presentation}/u;

/**
 * Terminal columns a string occupies. CJK and emoji take two, so naive .length
 * misaligns tables; colour codes and combining marks take none.
 */
export function stringWidth(input: string): number {
  if (PRINTABLE_ASCII.test(input)) return input.length;
  const text = input.includes("\x1b") ? input.replace(ANSI_PATTERN, "") : input;
  let width = 0;
  let joined = false;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // The glyph after a zero-width joiner merges into the preceding emoji.
    if (joined) {
      joined = false;
      continue;
    }
    if (code === 0x200d) {
      joined = true;
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code < 0xa0) || ZERO_WIDTH.test(char)) continue;
    width +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd) ||
      EMOJI.test(char)
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
