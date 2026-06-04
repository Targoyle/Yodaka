import { describe, expect, it } from "vitest";
import { encodeNevent, encodeNpub } from "./nip19";
import { prepareTextNotePublish } from "./textNotePublish";
import type { TimelineItem } from "../wasm/client";

const SAMPLE_EVENT_ID =
  "dbe57554549f92c08bea790b05dc37dec6f3373303123f9e231635ee594ceb6a";
const SAMPLE_NEVENT = encodeNevent(SAMPLE_EVENT_ID) ?? "";
const SAMPLE_MENTION_PUBKEY =
  "aa4fc8665f5696e33db7e1a572e3b0f5b3d615837b0f362dcb1c8068b098c7b4";
const SAMPLE_MENTION_NPUB = encodeNpub(SAMPLE_MENTION_PUBKEY) ?? "";
const SAMPLE_NPROFILE =
  "nprofile1qqszclxx9f5haga8sfjjrulaxncvkfekj097t6f3pu65f86rvg49ehqj6f9dh";
const SAMPLE_NADDR =
  "naddr1qqyrzwrxvc6ngvfkqyghwumn8ghj7enfv96x5ctx9e3k7mgzyqalp33lewf5vdq847t6te0wvnags0gs0mu72kz8938tn24wlfze6qcyqqq823cph95ag";

describe("prepareTextNotePublish", () => {
  it("top-level reply は root tag だけを付ける", () => {
    const rootItem = createTimelineItem({
      id: "root-id",
      pubkey: "a".repeat(64),
    });

    expect(
      prepareTextNotePublish({
        content: "hello",
        referenceItemsById: new Map([[rootItem.id, rootItem]]),
        replyTargetItem: rootItem,
      }),
    ).toEqual({
      content: "hello",
      tags: [
        ["e", "root-id", "", "root", "a".repeat(64)],
        ["p", "a".repeat(64)],
      ],
    });
  });

  it("reply chain と本文参照から e/p/q tag を構築する", () => {
    const rootItem = createTimelineItem({
      id: "root-id",
      pubkey: "a".repeat(64),
    });
    const replyItem = createTimelineItem({
      id: "reply-id",
      pubkey: "b".repeat(64),
      replyContextPubkeys: ["a".repeat(64)],
      replyTargetEventId: rootItem.id,
      replyTargetPubkey: rootItem.pubkey,
      replyTargetRelayHints: ["wss://root.example/"],
    });

    expect(
      prepareTextNotePublish({
        content: `hello ${SAMPLE_MENTION_NPUB} ${SAMPLE_NEVENT} nostr:${SAMPLE_NPROFILE} nostr:${SAMPLE_NADDR}`,
        referenceItemsById: new Map([
          [rootItem.id, rootItem],
          [replyItem.id, replyItem],
        ]),
        replyTargetItem: replyItem,
      }),
    ).toEqual({
      content: `hello nostr:${SAMPLE_MENTION_NPUB} nostr:${SAMPLE_NEVENT} nostr:${SAMPLE_NPROFILE} nostr:${SAMPLE_NADDR}`,
      tags: [
        ["e", "root-id", "wss://root.example/", "root", "a".repeat(64)],
        ["e", "reply-id", "", "reply", "b".repeat(64)],
        ["p", "b".repeat(64)],
        ["p", "a".repeat(64)],
        ["p", SAMPLE_MENTION_PUBKEY],
        ["p", "2c7cc62a697ea3a7826521f3fd34f0cb273693cbe5e9310f35449f43622a5cdc"],
        [
          "p",
          "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d",
          "wss://fiatjaf.com",
        ],
        ["q", SAMPLE_EVENT_ID],
        [
          "q",
          "30023:3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d:18ff5416",
          "wss://fiatjaf.com",
        ],
      ],
    });
  });
});

function createTimelineItem(
  overrides: Partial<TimelineItem> & Pick<TimelineItem, "id" | "pubkey">,
): TimelineItem {
  return {
    id: overrides.id,
    pubkey: overrides.pubkey,
    createdAt: overrides.createdAt ?? 1,
    kind: overrides.kind ?? 1,
    content: overrides.content ?? "",
    isReply: overrides.isReply ?? false,
    replyTargetEventId: overrides.replyTargetEventId ?? null,
    replyTargetPubkey: overrides.replyTargetPubkey ?? null,
    replyTargetRelayHints: overrides.replyTargetRelayHints ?? [],
    replyTargetProfile: overrides.replyTargetProfile ?? null,
    replyContextPubkeys: overrides.replyContextPubkeys ?? [],
    likeCount: overrides.likeCount ?? 0,
    kusaCount: overrides.kusaCount ?? 0,
    moreReactionCount: overrides.moreReactionCount ?? 0,
    otherReactionSummaries: overrides.otherReactionSummaries ?? [],
    profile: overrides.profile ?? null,
    notifyActorPubkey: overrides.notifyActorPubkey ?? null,
    notifyActorProfile: overrides.notifyActorProfile ?? null,
    notifyReactionContent: overrides.notifyReactionContent ?? null,
    notifyTargetEventId: overrides.notifyTargetEventId ?? null,
    notifyTargetResolved: overrides.notifyTargetResolved ?? false,
  };
}
