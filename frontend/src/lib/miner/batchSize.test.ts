import { describe, expect, it } from "vitest";
import {
  DEFAULT_MINER_BATCH_SIZE,
  MAX_MINER_BATCH_SIZE,
  validateMinerBatchSize,
} from "./batchSize";

describe("validateMinerBatchSize", () => {
  it("既定値を受け入れる", () => {
    expect(validateMinerBatchSize(DEFAULT_MINER_BATCH_SIZE)).toBe(
      DEFAULT_MINER_BATCH_SIZE,
    );
  });

  it("1 未満を拒否する", () => {
    expect(() => validateMinerBatchSize(0)).toThrow(
      "batch size は 1 以上の整数で指定してください",
    );
  });

  it("上限超過を拒否する", () => {
    expect(() => validateMinerBatchSize(MAX_MINER_BATCH_SIZE + 1)).toThrow(
      "batch size は 1,048,576 以下で指定してください",
    );
  });
});
