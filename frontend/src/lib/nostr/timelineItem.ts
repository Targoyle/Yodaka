import { normalizeHexPubkey } from "./pubkey";
import type { NostrEvent } from "./relay";
import type { TimelineItem, TimelineProfile } from "../wasm/client";

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
    repostTargetEventId: null,
    repostTargetPubkey: null,
    repostTargetRelayHints: [],
    repostTargetProfile: null,
    likeCount: 0,
    kusaCount: 0,
    moreReactionCount: 0,
    otherReactionSummaries: [],
    profile,
  };
}

export function parseEmbeddedNostrEventContent(
  content: string,
  expectedEventId?: string | null,
): NostrEvent | null {
  try {
    const parsed = JSON.parse(content);

    if (!isRecord(parsed)) {
      return null;
    }

    const id = parsed.id;
    const pubkey = parsed.pubkey;
    const createdAt = parsed.created_at;
    const kind = parsed.kind;
    const tags = parsed.tags;
    const embeddedContent = parsed.content;
    const sig = parsed.sig;

    if (
      typeof id !== "string"
      || typeof pubkey !== "string"
      || typeof createdAt !== "number"
      || !Number.isInteger(createdAt)
      || createdAt < 0
      || typeof kind !== "number"
      || !Number.isInteger(kind)
      || kind < 0
      || typeof embeddedContent !== "string"
      || typeof sig !== "string"
      || !Array.isArray(tags)
    ) {
      return null;
    }

    if (expectedEventId && id !== expectedEventId) {
      return null;
    }

    const normalizedPubkey = normalizeHexPubkey(pubkey);

    if (!normalizedPubkey) {
      return null;
    }

    const normalizedTags: string[][] = [];

    for (const tag of tags) {
      if (!Array.isArray(tag)) {
        return null;
      }

      const normalizedTag: string[] = [];

      for (const item of tag) {
        if (typeof item !== "string") {
          return null;
        }

        normalizedTag.push(item);
      }

      normalizedTags.push(normalizedTag);
    }

    return {
      id,
      pubkey: normalizedPubkey,
      created_at: createdAt,
      kind,
      tags: normalizedTags,
      content: embeddedContent,
      sig,
    };
  } catch {
    return null;
  }
}

export function buildEmbeddedRepostTargetTimelineItem(
  item: TimelineItem,
  profileSummaries?: ReadonlyMap<string, TimelineProfile>,
): TimelineItem | null {
  if (item.kind !== 6 || !item.repostTargetEventId || item.content.length === 0) {
    return null;
  }

  const event = parseEmbeddedNostrEventContent(
    item.content,
    item.repostTargetEventId,
  );

  if (!event || event.id === item.id) {
    return null;
  }

  const profile = (
    item.repostTargetProfile
    && (!item.repostTargetPubkey || item.repostTargetPubkey === event.pubkey)
  )
    ? item.repostTargetProfile
    : (profileSummaries?.get(event.pubkey) ?? null);

  return buildStandaloneTimelineItem(event, profile);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
