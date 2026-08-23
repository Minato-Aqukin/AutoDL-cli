import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { Login } from "../../src/tui/screens/login.js";

/**
 * The login screen exists because the dashboard became the default surface: a bare
 * `autodl` on an unconfigured machine has to land somewhere useful rather than on an
 * error telling the user to go read the docs.
 */

const plain = (s: string | undefined) =>
  (s ?? "").replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");

const ENTER = "\r";
const ESC = String.fromCharCode(27);
const BACKSPACE = String.fromCharCode(127);

/** Let React flush before reading a frame; state changes are not synchronous. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

function setup(overrides: Partial<Parameters<typeof Login>[0]> = {}) {
  const onSubmit = vi.fn();
  const onQuit = vi.fn();
  const result = render(
    <Login onSubmit={onSubmit} onQuit={onQuit} error={null} verifying={false} {...overrides} />,
  );
  return { ...result, onSubmit, onQuit };
}

describe("the menu", () => {
  it("offers exactly two ways forward", () => {
    const out = plain(setup().lastFrame());
    expect(out).toContain("配置 Token 登入");
    expect(out).toContain("退出");
  });

  it("starts on login rather than on quit", async () => {
    const { onQuit, onSubmit, stdin, lastFrame } = setup();
    stdin.write(ENTER);
    await flush();
    expect(onQuit).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    // Enter on the first choice opens the token field.
    expect(plain(lastFrame())).toContain("粘贴你的开发者 Token");
  });

  it("quits when the second choice is taken", async () => {
    const { onQuit, stdin } = setup();
    stdin.write("j");
    // The selection is state; Enter must be read after React has applied it.
    await flush();
    stdin.write(ENTER);
    expect(onQuit).toHaveBeenCalled();
  });

  it("quits on q", () => {
    const { onQuit, stdin } = setup();
    stdin.write("q");
    expect(onQuit).toHaveBeenCalled();
  });
});

describe("the token field", () => {
  async function openField() {
    const harness = setup();
    harness.stdin.write(ENTER);
    await flush();
    return harness;
  }

  it("masks what is typed", async () => {
    const { stdin, lastFrame } = await openField();
    stdin.write("secret-token");
    await flush();
    const out = plain(lastFrame());
    expect(out).not.toContain("secret-token");
    expect(out).toContain("•");
  });

  it("reports the length, so a paste is visibly confirmed", async () => {
    // A JWT is far too long to type; without this the field looks inert after a paste.
    const { stdin, lastFrame } = await openField();
    stdin.write("abcdefghij");
    await flush();
    expect(plain(lastFrame())).toContain("(10 字符)");
  });

  it("accepts a paste arriving as one chunk", async () => {
    const { stdin, onSubmit } = await openField();
    stdin.write("eyJhbGciOiJFUzI1NiJ9.payload.signature");
    await flush();
    stdin.write(ENTER);
    expect(onSubmit).toHaveBeenCalledWith("eyJhbGciOiJFUzI1NiJ9.payload.signature");
  });

  it("strips control characters a paste can smuggle in", async () => {
    const { stdin, onSubmit } = await openField();
    stdin.write(`abc${String.fromCharCode(0)}def`);
    await flush();
    stdin.write(ENTER);
    expect(onSubmit).toHaveBeenCalledWith("abcdef");
  });

  it("supports backspace", async () => {
    const { stdin, onSubmit } = await openField();
    stdin.write("abcd");
    await flush();
    stdin.write(BACKSPACE);
    await flush();
    stdin.write(ENTER);
    expect(onSubmit).toHaveBeenCalledWith("abc");
  });

  it("does not submit an empty field", async () => {
    const { stdin, onSubmit } = await openField();
    stdin.write(ENTER);
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("goes back to the menu on Esc, discarding what was typed", async () => {
    // Esc is the escape hatch from the field, since `q` has to remain a valid token
    // character rather than a quit key.
    const { stdin, lastFrame } = await openField();
    stdin.write("partial");
    await flush();
    stdin.write(ESC);
    await flush();
    expect(plain(lastFrame())).toContain("配置 Token 登入");
    stdin.write(ENTER);
    await flush();
    expect(plain(lastFrame())).toContain("等待输入…");
  });

  it("ignores input while a token is being verified", async () => {
    const { stdin, onSubmit } = setup({ verifying: true });
    stdin.write(ENTER);
    await flush();
    stdin.write("anything");
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("failures", () => {
  it("shows the reason and keeps the user on the screen", () => {
    const out = plain(setup({ error: "Token 无效或已失效" }).lastFrame());
    expect(out).toContain("Token 无效或已失效");
    // Still offering a way forward rather than having exited.
    expect(out).toContain("配置 Token 登入");
  });

  it("says where a verified token will be stored", () => {
    const out = plain(setup().lastFrame());
    expect(out).toContain("0600");
  });
});
