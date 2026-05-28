export const DEFAULT_MINER_BATCH_SIZE = 65_536;

// Keep dispatchWorkgroups comfortably below common per-dimension limits.
export const MAX_MINER_BATCH_SIZE = 1_048_576;

export function validateMinerBatchSize(batchSize: number) {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("batch size は 1 以上の整数で指定してください");
  }

  if (batchSize > MAX_MINER_BATCH_SIZE) {
    throw new Error(
      `batch size は ${MAX_MINER_BATCH_SIZE.toLocaleString("ja-JP")} 以下で指定してください`,
    );
  }

  return batchSize;
}
