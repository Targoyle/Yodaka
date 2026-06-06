import { describe, expect, it } from "vitest";
import type { NostrEvent } from "../lib/nostr/relay";
import type { TimelineItem } from "../lib/wasm/client";
import {
  buildImmediateNotifyTimelineState,
  mergeNotifyEventIds,
  mergeNotifyEvents,
} from "./useNotifyTimeline";

describe("mergeNotifyEvents", () => {
  it("prefers live events and deduplicates by id", () => {
    const fetchedReaction: NostrEvent = {
      id: "reaction-1",
      pubkey: "a".repeat(64),
      created_at: 10,
      kind: 7,
      tags: [["e", "target-1"]],
      content: "+",
      sig: "sig-1",
    };
    const olderReaction: NostrEvent = {
      id: "reaction-2",
      pubkey: "b".repeat(64),
      created_at: 9,
      kind: 7,
      tags: [["e", "target-2"]],
      content: ":kusa:",
      sig: "sig-2",
    };

    expect(
      mergeNotifyEvents(
        [olderReaction, fetchedReaction],
        [fetchedReaction],
        10,
      ).map((event) => event.id),
    ).toEqual(["reaction-2", "reaction-1"]);
  });
});

describe("buildImmediateNotifyTimelineState", () => {
  it("inserts a live reaction into the notify timeline immediately", () => {
    const targetItem: TimelineItem = {
      id: "c".repeat(64),
      pubkey: "c".repeat(64),
      createdAt: 20,
      kind: 1,
      content: "target note",
      isReply: false,
      replyTargetEventId: null,
      replyTargetPubkey: null,
      replyTargetProfile: null,
      replyContextPubkeys: [],
      likeCount: 0,
      profile: null,
    };
    const existingNotifyItem: TimelineItem = {
      id: "d".repeat(64),
      pubkey: "d".repeat(64),
      createdAt: 10,
      kind: 1,
      content: "existing notify",
      isReply: false,
      replyTargetEventId: null,
      replyTargetPubkey: null,
      replyTargetProfile: null,
      replyContextPubkeys: [],
      likeCount: 0,
      profile: null,
    };
    const liveReactionEvent: NostrEvent = {
      id: "e".repeat(64),
      pubkey: "e".repeat(64),
      created_at: 30,
      kind: 7,
      tags: [["e", targetItem.id]],
      content: "+",
      sig: "sig-live",
    };

    const nextNotifyEventIds = mergeNotifyEventIds(
      [liveReactionEvent.id],
      [existingNotifyItem.id],
      10,
    );
    const nextTimeline = buildImmediateNotifyTimelineState({
      currentItems: [existingNotifyItem],
      event: liveReactionEvent,
      notifyEventIds: nextNotifyEventIds,
      profileSummaries: new Map(),
      referenceItems: [targetItem, existingNotifyItem],
      timelineLimit: 10,
    });

    expect(nextTimeline.map((item) => item.id)).toEqual([
      liveReactionEvent.id,
      existingNotifyItem.id,
    ]);
    expect(nextTimeline[0]?.pubkey).toBe(targetItem.pubkey);
    expect(nextTimeline[0]?.content).toBe(targetItem.content);
    expect(nextTimeline[0]?.notifyActorPubkey).toBe(liveReactionEvent.pubkey);
    expect(nextTimeline[0]?.notifyReactionContent).toBe(liveReactionEvent.content);
    expect(nextTimeline[0]?.notifyTargetEventId).toBe(targetItem.id);
    expect(nextTimeline[0]?.notifyTargetResolved).toBe(true);
  });
});
