import { describe, expect, it } from "vitest";
import {
  buildReplyPreviewLookupRequests,
} from "./useReplyPreviewCache";
import type { TimelineItem } from "../lib/wasm/client";

describe("buildReplyPreviewLookupRequests", () => {
  it("hint relay だけでも lookup request を作り、同一 target の hint を束ねる", () => {
    const visibleTimeline: TimelineItem[] = [
      createTimelineItem({
        id: "reply-a",
        replyTargetEventId: "target-id",
        replyTargetPubkey: "a".repeat(64),
        replyTargetRelayHints: ["wss://hint-a.example"],
      }),
      createTimelineItem({
        id: "reply-b",
        replyTargetEventId: "target-id",
        replyTargetPubkey: "a".repeat(64),
        replyTargetRelayHints: ["wss://hint-b.example/"],
      }),
    ];

    expect(
      buildReplyPreviewLookupRequests({
        embeddedResolvedEventIds: new Set(),
        now: 100,
        readRelayUrls: [],
        referenceItemIds: new Set(),
        replyPreviewCache: {},
        visibleTimeline,
      }),
    ).toEqual([
      {
        authorPubkey: "a".repeat(64),
        baseRelayUrls: [
          "wss://hint-a.example/",
          "wss://hint-b.example/",
        ],
        eventId: "target-id",
        relayListLookupRelayUrls: [
          "wss://hint-a.example/",
          "wss://hint-b.example/",
        ],
      },
    ]);
  });

  it("retry 待ちの target は再要求しない", () => {
    expect(
      buildReplyPreviewLookupRequests({
        embeddedResolvedEventIds: new Set(),
        now: 100,
        readRelayUrls: ["wss://read.example"],
        referenceItemIds: new Set(),
        replyPreviewCache: {
          "target-id": {
            status: "missing",
            retryAt: 101,
          },
        },
        visibleTimeline: [
          createTimelineItem({
            id: "reply-a",
            replyTargetEventId: "target-id",
            replyTargetPubkey: "a".repeat(64),
            replyTargetRelayHints: ["wss://hint-a.example"],
          }),
        ],
      }),
    ).toEqual([]);
  });
});

function createTimelineItem(
  overrides: Partial<TimelineItem>,
): TimelineItem {
  return {
    id: "note-id",
    pubkey: "b".repeat(64),
    createdAt: 10,
    kind: 1,
    content: "hello",
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
    profile: null,
    ...overrides,
  };
}
