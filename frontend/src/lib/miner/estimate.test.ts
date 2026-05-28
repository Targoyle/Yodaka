import { describe, expect, it } from "vitest";
import {
  estimateExpectedAttemptsForAffixLength,
  estimateExpectedMiningSeconds,
  formatElapsedMiningTime,
  formatEstimatedMiningTime,
  getMiningAffixLength,
} from "./estimate";

describe("getMiningAffixLength", () => {
  it("prefix と suffix の trim 後の合計長を返す", () => {
    expect(
      getMiningAffixLength({
        prefix: " y0d ",
        suffix: " hawk ",
      }),
    ).toBe(7);
  });
});

describe("estimateExpectedAttemptsForAffixLength", () => {
  it("合計長に応じて 32^n 通りを返す", () => {
    expect(estimateExpectedAttemptsForAffixLength(4)).toBe(1_048_576);
  });

  it("長さ 0 以下では 1 を返す", () => {
    expect(estimateExpectedAttemptsForAffixLength(0)).toBe(1);
    expect(estimateExpectedAttemptsForAffixLength(-1)).toBe(1);
  });
});

describe("estimateExpectedMiningSeconds", () => {
  it("速度があれば期待探索秒数を返す", () => {
    expect(
      estimateExpectedMiningSeconds({
        affixLength: 4,
        keysPerSecond: 1_024,
      }),
    ).toBe(1_024);
  });

  it("速度未確定または長さ 0 では null を返す", () => {
    expect(
      estimateExpectedMiningSeconds({
        affixLength: 4,
        keysPerSecond: 0,
      }),
    ).toBeNull();
    expect(
      estimateExpectedMiningSeconds({
        affixLength: 0,
        keysPerSecond: 10_000,
      }),
    ).toBeNull();
  });
});

describe("formatElapsedMiningTime", () => {
  it("経過時間を読みやすく整形する", () => {
    expect(formatElapsedMiningTime(0)).toBe("00:00:00");
    expect(formatElapsedMiningTime(65_000)).toBe("00:01:05");
    expect(formatElapsedMiningTime(3_720_000)).toBe("01:02:00");
  });
});

describe("formatEstimatedMiningTime", () => {
  it("期待探索時間を近似表記する", () => {
    expect(formatEstimatedMiningTime(null)).toBe("開始後に推定");
    expect(formatEstimatedMiningTime(0.4)).toBe("00:00:00");
    expect(formatEstimatedMiningTime(1_024)).toBe("00:17:04");
    expect(formatEstimatedMiningTime(90_061)).toBe("1日 01:01:01");
    expect(formatEstimatedMiningTime(45 * 24 * 60 * 60)).toBe("1か月 15日");
    expect(formatEstimatedMiningTime((3 * 365 + 60) * 24 * 60 * 60)).toBe("3年 2か月");
  });

  it("千年以上は和数詞で年数を整形する", () => {
    expect(formatEstimatedMiningTime(1_500 * 365 * 24 * 60 * 60)).toBe("1.5千年");
    expect(formatEstimatedMiningTime(12_345 * 365 * 24 * 60 * 60)).toBe("1.23万年");
  });
});
