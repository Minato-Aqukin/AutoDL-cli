import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { platform } from "node:os";

/**
 * Copy text to the system clipboard.
 *
 * Tries a native helper first, then falls back to OSC 52 — an escape sequence that asks
 * the *terminal* to do the copying. That fallback is what makes this work over SSH and
 * in containers, where no clipboard binary exists locally.
 */

export type CopyMethod = "native" | "osc52";

export interface CopyResult {
  ok: boolean;
  method: CopyMethod;
  /** Set when the native path was unavailable, so callers can be honest about it. */
  note?: string;
}

/** Candidate helpers per platform, most specific first. */
function candidates(): { command: string; args: string[] }[] {
  switch (platform()) {
    case "darwin":
      return [{ command: "pbcopy", args: [] }];
    case "win32":
      return [{ command: "clip", args: [] }];
    default:
      return [
        // Wayland first: on a Wayland session xclip often exists but silently fails.
        { command: "wl-copy", args: [] },
        { command: "xclip", args: ["-selection", "clipboard"] },
        { command: "xsel", args: ["--clipboard", "--input"] },
      ];
  }
}

function runCopy(command: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin?.on("error", () => resolve(false));
    child.stdin?.end(text);
  });
}

/**
 * OSC 52: ask the terminal emulator to set the clipboard.
 *
 * Fire-and-forget — the terminal never replies, and many disable it by default — so
 * this can only ever be reported as "requested", not "done".
 */
function writeOsc52(text: string): void {
  const payload = Buffer.from(text, "utf8").toString("base64");
  // ESC ] 52 ; c ; <base64> BEL, spelled with char codes so the literal control
  // characters never have to survive a round trip through source tooling.
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  process.stdout.write(`${ESC}]52;c;${payload}${BEL}`);
}

export async function copyToClipboard(text: string): Promise<CopyResult> {
  for (const { command, args } of candidates()) {
    if (await runCopy(command, args, text)) {
      return { ok: true, method: "native" };
    }
  }

  writeOsc52(text);
  return {
    ok: true,
    method: "osc52",
    note: "已通过终端（OSC 52）请求复制，部分终端默认禁用此功能",
  };
}
