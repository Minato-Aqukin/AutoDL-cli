import { describe, expect, it } from "vitest";
import { centeredStart } from "../../src/tui/scroll.js";

/**
 * The window every scrolling list uses. Off-by-ones here show up as a cursor scrolled
 * out of view, blank rows padding the end of a list, or a cursor glued to an edge.
 */

describe("centeredStart", () => {
  it("keeps the cursor visible, centred away from the ends, with no blank rows", () => {
    for (let total = 1; total <= 30; total += 1) {
      for (let rows = 1; rows <= 12; rows += 1) {
        const visible = Math.min(rows, total);
        const middle = Math.floor((visible - 1) / 2);
        for (let index = 0; index < total; index += 1) {
          const start = centeredStart(index, total, rows);
          const context = { total, rows, index, start };

          expect(start, JSON.stringify(context)).toBeGreaterThanOrEqual(0);
          expect(start + visible, JSON.stringify(context)).toBeLessThanOrEqual(total);
          expect(index - start, JSON.stringify(context)).toBeGreaterThanOrEqual(0);
          expect(index - start, JSON.stringify(context)).toBeLessThan(visible);
          // Off centre only where the window has hit an end of the list.
          if (start > 0 && start + visible < total) {
            expect(index - start, JSON.stringify(context)).toBe(middle);
          }
        }
      }
    }
  });

  it("starts at the top for an empty list", () => {
    expect(centeredStart(0, 0, 10)).toBe(0);
  });
});
