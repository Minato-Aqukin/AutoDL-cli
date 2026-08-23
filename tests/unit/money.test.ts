import { describe, expect, it } from "vitest";
import {
  estimateCost,
  formatRate,
  formatYuan,
  milliToYuan,
  yuanToMilli,
} from "../../src/core/money.js";

describe("milliyuan conversion", () => {
  it("converts AutoDL's integer milliyuan to yuan", () => {
    // 1970 milliyuan is the payg_price in AutoDL's own snapshot example.
    expect(milliToYuan(1970)).toBe(1.97);
    expect(milliToYuan(12_340)).toBe(12.34);
    expect(milliToYuan(0)).toBe(0);
  });

  it("treats missing values as zero rather than NaN", () => {
    expect(milliToYuan(null)).toBe(0);
    expect(milliToYuan(undefined)).toBe(0);
    expect(milliToYuan(Number.NaN)).toBe(0);
  });

  it("round-trips through yuanToMilli", () => {
    expect(yuanToMilli(1.97)).toBe(1970);
    expect(milliToYuan(yuanToMilli(43.21))).toBe(43.21);
  });

  it("avoids float dust on repeating decimals", () => {
    expect(milliToYuan(1)).toBe(0);
    expect(milliToYuan(5)).toBe(0.01);
    expect(milliToYuan(3333)).toBe(3.33);
  });
});

describe("formatting", () => {
  it("renders yuan with two decimals", () => {
    expect(formatYuan(1.97)).toBe("¥1.97");
    expect(formatYuan(0)).toBe("¥0.00");
  });

  it("renders an hourly rate", () => {
    expect(formatRate(1.97)).toBe("¥1.97/时");
  });
});

describe("estimateCost", () => {
  it("bills by the second rather than rounding up to whole hours", () => {
    // AutoDL charges 时长 x 单价 with 时长 precise to the second.
    expect(estimateCost(2, 1800)).toBe(1);
    expect(estimateCost(2, 3600)).toBe(2);
    expect(estimateCost(3.6, 100)).toBe(0.1);
  });

  it("applies AutoDL's ¥0.01 minimum charge", () => {
    expect(estimateCost(1, 1)).toBe(0.01);
  });

  it("returns zero for a zero-length run", () => {
    expect(estimateCost(2, 0)).toBe(0);
  });
});
