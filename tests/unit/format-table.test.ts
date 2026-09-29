import pc from "picocolors";
import { describe, expect, it } from "vitest";
import { stringWidth, table } from "../../src/output/format.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping SGR codes.
const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("stringWidth", () => {
  it("counts terminal columns, not code units", () => {
    expect(stringWidth("pro-1")).toBe(5);
    expect(stringWidth("训练机")).toBe(6);
    expect(stringWidth("🚀x")).toBe(3);
    expect(stringWidth("𠀀")).toBe(2);
  });

  it("gives colour codes, combining marks and joined emoji no extra width", () => {
    expect(stringWidth("\x1b[32mrunning\x1b[39m")).toBe(7);
    expect(stringWidth("e\u0301")).toBe(1);
    expect(stringWidth("👨‍👩‍👧")).toBe(2);
  });
});

describe("table", () => {
  it("pads every column to its widest visible cell, colour and CJK included", () => {
    const lines = plain(
      table(
        ["实例 ID", "名称", "状态"],
        [
          ["pro-1", "训练机", pc.green("running")],
          ["pro-22", "a", 3],
        ],
      ),
    ).split("\n");
    expect(lines).toEqual([
      "┌─────────┬────────┬─────────┐",
      "│ 实例 ID │ 名称   │ 状态    │",
      "├─────────┼────────┼─────────┤",
      "│ pro-1   │ 训练机 │ running │",
      "├─────────┼────────┼─────────┤",
      "│ pro-22  │ a      │ 3       │",
      "└─────────┴────────┴─────────┘",
    ]);
  });

  it("renders a header-only box when there are no rows", () => {
    expect(plain(table(["A"], []))).toBe(["┌───┐", "│ A │", "└───┘"].join("\n"));
  });

  it("stacks multi-line cells within one row", () => {
    expect(plain(table(["a", "b"], [["line1\nline2", "x"]])).split("\n")).toEqual([
      "┌───────┬───┐",
      "│ a     │ b │",
      "├───────┼───┤",
      "│ line1 │ x │",
      "│ line2 │   │",
      "└───────┴───┘",
    ]);
  });
});
