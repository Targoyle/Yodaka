import { formatReactionContentLabel } from "../nostr/reaction";
import type { TimelineItem } from "../wasm/client";

export function formatReplyPreviewContent(item: TimelineItem) {
  const rawContent =
    item.kind === 7
      ? formatReactionContentLabel(item.content)
      : item.content;
  const normalized = rawContent.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return null;
  }

  return normalized.slice(0, 140);
}
