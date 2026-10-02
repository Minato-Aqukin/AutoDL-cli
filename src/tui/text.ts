/** C0 controls, DEL, and C1 controls (U+0080–U+009F) never reach the screen or fields. */
export function isVisibleCode(code: number): boolean {
  if (code < 0x20 || code === 0x7f) return false;
  if (code >= 0x80 && code <= 0x9f) return false;
  return true;
}

/** Keep what a text field may hold: typed or pasted text minus control characters. */
export function sanitizeInput(input: string): string {
  let out = "";
  for (const char of input) {
    if (isVisibleCode(char.codePointAt(0) ?? 0)) out += char;
  }
  return out;
}
