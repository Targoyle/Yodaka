import type { RelayPublishResult } from "../nostr/relayCoordinator";

export function shortenBech32(value: string) {
  if (value.length <= 28) {
    return value;
  }

  return `${value.slice(0, 18)}…${value.slice(-8)}`;
}

export function formatCreatedAt(createdAt: number) {
  return new Date(createdAt * 1000).toLocaleString("ja-JP", {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

export function formatCreatedAtParts(createdAt: number) {
  const date = new Date(createdAt * 1000);

  return {
    date: date.toLocaleDateString("ja-JP", {
      dateStyle: "medium",
    }),
    time: date.toLocaleTimeString("ja-JP", {
      timeStyle: "medium",
    }),
  };
}

export function formatRecordedAt(timestampMs: number | null) {
  if (!timestampMs || timestampMs <= 0) {
    return "未記録";
  }

  return new Date(timestampMs).toLocaleString("ja-JP", {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

export function formatRetryDelay(retryInMs: number) {
  const seconds = Math.max(1, Math.ceil(retryInMs / 1000));
  return `${seconds} 秒後`;
}

export function formatPublishSuccessMessage(result: RelayPublishResult) {
  const acceptedCount = result.acceptedRelayUrls.length;
  const rejectedCount = result.rejectedRelayUrls.length;

  if (rejectedCount === 0) {
    return `${acceptedCount} relay に投稿しました`;
  }

  return `${acceptedCount} relay へ投稿、${rejectedCount} relay は未送信です`;
}

export function formatReactionSuccessMessage(result: RelayPublishResult) {
  const acceptedCount = result.acceptedRelayUrls.length;
  const rejectedCount = result.rejectedRelayUrls.length;

  if (rejectedCount === 0) {
    return `${acceptedCount} relay にリアクションしました`;
  }

  return `${acceptedCount} relay へリアクション、${rejectedCount} relay は未送信です`;
}

export function formatRepostSuccessMessage(result: RelayPublishResult) {
  const acceptedCount = result.acceptedRelayUrls.length;
  const rejectedCount = result.rejectedRelayUrls.length;

  if (rejectedCount === 0) {
    return `${acceptedCount} relay にリポストしました`;
  }

  return `${acceptedCount} relay へリポスト、${rejectedCount} relay は未送信です`;
}
