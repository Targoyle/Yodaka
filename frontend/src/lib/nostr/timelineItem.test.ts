import { describe, expect, it } from "vitest";
import {
  buildEmbeddedRepostTargetTimelineItem,
  parseEmbeddedNostrEventContent,
} from "./timelineItem";
import type { TimelineItem } from "../wasm/client";

describe("parseEmbeddedNostrEventContent", () => {
  it("repost content に埋め込まれた event JSON を復元する", () => {
    expect(
      parseEmbeddedNostrEventContent(
        JSON.stringify({
          id: "target-id",
          pubkey: "A".repeat(64),
          created_at: 123,
          kind: 1,
          tags: [["t", "nostr"]],
          content: "hello",
          sig: "sig",
        }),
        "target-id",
      ),
    ).toEqual({
      id: "target-id",
      pubkey: "a".repeat(64),
      created_at: 123,
      kind: 1,
      tags: [["t", "nostr"]],
      content: "hello",
      sig: "sig",
    });
  });

  it("期待する event id と違う場合は null を返す", () => {
    expect(
      parseEmbeddedNostrEventContent(
        JSON.stringify({
          id: "other-id",
          pubkey: "a".repeat(64),
          created_at: 123,
          kind: 1,
          tags: [],
          content: "hello",
          sig: "sig",
        }),
        "target-id",
      ),
    ).toBeNull();
  });
});

describe("buildEmbeddedRepostTargetTimelineItem", () => {
  it("kind 6 の content から元ポストのカードを組み立てる", () => {
    const item: TimelineItem = {
      id: "repost-id",
      pubkey: "b".repeat(64),
      createdAt: 200,
      kind: 6,
      content: JSON.stringify({
        id: "target-id",
        pubkey: "a".repeat(64),
        created_at: 123,
        kind: 1,
        tags: [],
        content: "embedded note",
        sig: "sig",
      }),
      isReply: false,
      replyTargetEventId: null,
      replyTargetPubkey: null,
      replyTargetRelayHints: [],
      replyTargetProfile: null,
      replyContextPubkeys: [],
      repostTargetEventId: "target-id",
      repostTargetPubkey: "a".repeat(64),
      repostTargetRelayHints: [],
      repostTargetProfile: {
        name: null,
        displayName: "Target User",
        picture: null,
      },
      likeCount: 0,
      kusaCount: 0,
      moreReactionCount: 0,
      otherReactionSummaries: [],
      profile: null,
    };

    expect(buildEmbeddedRepostTargetTimelineItem(item)).toEqual({
      id: "target-id",
      pubkey: "a".repeat(64),
      createdAt: 123,
      kind: 1,
      content: "embedded note",
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
      profile: {
        name: null,
        displayName: "Target User",
        picture: null,
      },
    });
  });

  it("repost content が空なら null を返す", () => {
    const item: TimelineItem = {
      id: "repost-id",
      pubkey: "b".repeat(64),
      createdAt: 200,
      kind: 6,
      content: "",
      isReply: false,
      replyTargetEventId: null,
      replyTargetPubkey: null,
      replyTargetRelayHints: [],
      replyTargetProfile: null,
      replyContextPubkeys: [],
      repostTargetEventId: "target-id",
      repostTargetPubkey: "a".repeat(64),
      repostTargetRelayHints: [],
      repostTargetProfile: null,
      likeCount: 0,
      kusaCount: 0,
      moreReactionCount: 0,
      otherReactionSummaries: [],
      profile: null,
    };

    expect(buildEmbeddedRepostTargetTimelineItem(item)).toBeNull();
  });
});
