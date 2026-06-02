import type { NostrEvent } from "./relay";
import type { TimelineItem } from "../wasm/client";

export function buildStandaloneTimelineItem(
  event: NostrEvent,
  profile: TimelineItem["profile"],
): TimelineItem {
  return {
    id: event.id,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    kind: event.kind,
    content: event.content,
    isReply: false,
    replyTargetEventId: null,
    replyTargetPubkey: null,
    replyTargetRelayHints: [],
    replyTargetProfile: null,
    replyContextPubkeys: [],
    likeCount: 0,
    kusaCount: 0,
    moreReactionCount: 0,
    otherReactionSummaries: [],
    profile,
  };
}
