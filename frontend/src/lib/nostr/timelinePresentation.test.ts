import { describe, expect, it } from "vitest";
import {
  buildAuxiliaryTimeline,
  buildVisibleTimeline,
  mergeAuxiliaryTimeline,
} from "./timelinePresentation";
import type { TimelineItem } from "../wasm/client";
import type { NostrEvent } from "./relay";

describe("buildAuxiliaryTimeline", () => {
  it("derives reply target pubkey from referenced timeline item", () => {
    const rootItem: TimelineItem = {
      id: "root-id",
      pubkey: "b".repeat(64),
      createdAt: 1,
      kind: 1,
      content: "root",
      isReply: false,
      replyTargetPubkey: null,
      replyTargetProfile: null,
      replyContextPubkeys: [],
      likeCount: 0,
      profile: {
        name: null,
        displayName: "Root User",
        picture: null,
      },
    };
    const replyEvent: NostrEvent = {
      id: "reply-id",
      pubkey: "a".repeat(64),
      created_at: 2,
      kind: 1,
      tags: [["e", "root-id", "", "reply"]],
      content: "reply",
      sig: "sig",
    };

    const [replyItem] = buildAuxiliaryTimeline({
      events: [replyEvent],
      profileSummaries: new Map([[rootItem.pubkey, rootItem.profile!]]),
      referenceItems: [rootItem],
      timelineLimit: 20,
    });

    expect(replyItem?.replyTargetPubkey).toBe(rootItem.pubkey);
    expect(replyItem?.replyTargetEventId).toBe(rootItem.id);
    expect(replyItem?.replyTargetProfile?.displayName).toBe("Root User");
    expect(replyItem?.replyContextPubkeys).toEqual([rootItem.pubkey]);
  });

  it("prefers reply e-tag author and keeps self at the tail of reply bands", () => {
    const replyTargetPubkey = "c".repeat(64);
    const selfPubkey = "a".repeat(64);
    const replyEvent: NostrEvent = {
      id: "reply-id",
      pubkey: selfPubkey,
      created_at: 2,
      kind: 1,
      tags: [
        ["e", "unknown-root-id", "", "reply", replyTargetPubkey],
        ["p", replyTargetPubkey],
        ["p", selfPubkey],
      ],
      content: "reply",
      sig: "sig",
    };

    const [replyItem] = buildAuxiliaryTimeline({
      events: [replyEvent],
      profileSummaries: new Map(),
      referenceItems: [],
      timelineLimit: 20,
    });

    expect(replyItem?.replyTargetPubkey).toBe(replyTargetPubkey);
    expect(replyItem?.replyTargetEventId).toBe("unknown-root-id");
    expect(replyItem?.replyContextPubkeys).toEqual([replyTargetPubkey, selfPubkey]);
  });

  it("prefers non-self recipient over self when root author points to self", () => {
    const selfPubkey = "a".repeat(64);
    const otherPubkey = "b".repeat(64);
    const replyEvent: NostrEvent = {
      id: "reply-id",
      pubkey: selfPubkey,
      created_at: 2,
      kind: 1,
      tags: [
        ["e", "root-id", "", "root", selfPubkey],
        ["p", selfPubkey],
        ["p", otherPubkey],
      ],
      content: "reply",
      sig: "sig",
    };

    const [replyItem] = buildAuxiliaryTimeline({
      events: [replyEvent],
      profileSummaries: new Map(),
      referenceItems: [],
      timelineLimit: 20,
    });

    expect(replyItem?.replyTargetPubkey).toBe(otherPubkey);
    expect(replyItem?.replyContextPubkeys).toEqual([otherPubkey, selfPubkey]);
  });

  it("derives a reply target from root-only references when only one recipient is known", () => {
    const rootPubkey = "d".repeat(64);
    const replyEvent: NostrEvent = {
      id: "reply-id",
      pubkey: "a".repeat(64),
      created_at: 2,
      kind: 1,
      tags: [
        ["e", "root-id", "", "root", rootPubkey],
        ["p", rootPubkey],
      ],
      content: "reply",
      sig: "sig",
    };

    const [replyItem] = buildAuxiliaryTimeline({
      events: [replyEvent],
      profileSummaries: new Map(),
      referenceItems: [],
      timelineLimit: 20,
    });

    expect(replyItem?.replyTargetPubkey).toBe(rootPubkey);
    expect(replyItem?.replyTargetEventId).toBe("root-id");
    expect(replyItem?.replyContextPubkeys).toEqual([rootPubkey]);
  });

  it("prefers the non-self root author while keeping self as the second band", () => {
    const selfPubkey = "26bb2ebed6c552d670c804b0d655267b3c662b21e026d6e48ac93a6070530958";
    const otherPubkey = "2d5b6404df532de082d9e77f7f4257a6f43fb79bb9de8dd3ac7df5e6d4b500b0";
    const replyEvent: NostrEvent = {
      id: "87990511425399dab599bf4ceb782c3ef273dfefdb9639a21429f7de2b738976",
      pubkey: selfPubkey,
      created_at: 1780033804,
      kind: 1,
      tags: [
        [
          "e",
          "b32574733bfee3bde2ba32a700e1182814c4e488f22c1a680236e9e4cba807d7",
          "wss://yabu.me/",
          "root",
          otherPubkey,
        ],
        [
          "e",
          "64f2497b4de043dda01c004723e916a49757fb2d828598c9e85e18faf2c43e4f",
          "wss://yabu.me/",
          "",
          selfPubkey,
        ],
        [
          "e",
          "2b06964a27a0867bd71c11ecefd9c9d71653da9e8bdcadb9190f6a4eaf61d3bd",
          "wss://yabu.me/",
          "reply",
          selfPubkey,
        ],
        ["p", selfPubkey, "wss://yabu.me/"],
        ["p", otherPubkey, "wss://yabu.me/"],
      ],
      content: "nosskey-sdkのバージョン最新に上げてもいいかも。あとでPRだすかも。",
      sig: "sig",
    };

    const [replyItem] = buildAuxiliaryTimeline({
      events: [replyEvent],
      profileSummaries: new Map(),
      referenceItems: [],
      timelineLimit: 20,
    });

    expect(replyItem?.replyTargetPubkey).toBe(otherPubkey);
    expect(replyItem?.replyTargetEventId).toBe(
      "2b06964a27a0867bd71c11ecefd9c9d71653da9e8bdcadb9190f6a4eaf61d3bd",
    );
    expect(replyItem?.replyContextPubkeys).toEqual([otherPubkey, selfPubkey]);
  });

  it("treats root-only replies as replies to the root author", () => {
    const rootPubkey = "5f468793f9a7bd70827cdad5c5677e3e5997fa53d0920aaac4e302ac0d48e8e7";
    const replyEvent: NostrEvent = {
      id: "4b7ab623505c62483201297b66764c8798cb62fd203dfbded6aaa98623047824",
      pubkey: "2bb2abbfc5892b7bda8f78d53682d913cc9a446b45e11929f0935d8fdfcb40bd",
      created_at: 1780034154,
      kind: 1,
      tags: [
        [
          "e",
          "932da9ea56452a133182158c6de18cc27918e2acdf310537ac9bbae62fbc11e3",
          "",
          "root",
          rootPubkey,
        ],
        ["p", rootPubkey],
      ],
      content: "ありえへん……このワイが……",
      sig: "sig",
    };

    const [replyItem] = buildAuxiliaryTimeline({
      events: [replyEvent],
      profileSummaries: new Map(),
      referenceItems: [],
      timelineLimit: 20,
    });

    expect(replyItem?.replyTargetPubkey).toBe(rootPubkey);
    expect(replyItem?.replyTargetEventId).toBe(
      "932da9ea56452a133182158c6de18cc27918e2acdf310537ac9bbae62fbc11e3",
    );
    expect(replyItem?.replyContextPubkeys).toEqual([rootPubkey]);
  });

  it("treats a single positional e-tag as the reply target", () => {
    const replyTargetPubkey = "f".repeat(64);
    const replyEvent: NostrEvent = {
      id: "reply-id",
      pubkey: "a".repeat(64),
      created_at: 2,
      kind: 1,
      tags: [
        ["e", "target-id", "wss://relay.example/", "", replyTargetPubkey],
        ["p", replyTargetPubkey],
      ],
      content: "reply",
      sig: "sig",
    };

    const [replyItem] = buildAuxiliaryTimeline({
      events: [replyEvent],
      profileSummaries: new Map(),
      referenceItems: [],
      timelineLimit: 20,
    });

    expect(replyItem?.replyTargetEventId).toBe("target-id");
    expect(replyItem?.replyTargetPubkey).toBe(replyTargetPubkey);
    expect(replyItem?.replyTargetRelayHints).toEqual(["wss://relay.example/"]);
  });

  it("treats the second positional e-tag as the direct reply target", () => {
    const rootPubkey = "b".repeat(64);
    const replyPubkey = "c".repeat(64);
    const replyEvent: NostrEvent = {
      id: "reply-id",
      pubkey: "a".repeat(64),
      created_at: 2,
      kind: 1,
      tags: [
        ["e", "root-id", "wss://root.example/", "", rootPubkey],
        ["e", "reply-id-2", "wss://reply.example/", "", replyPubkey],
        ["p", rootPubkey],
        ["p", replyPubkey],
      ],
      content: "reply",
      sig: "sig",
    };

    const [replyItem] = buildAuxiliaryTimeline({
      events: [replyEvent],
      profileSummaries: new Map(),
      referenceItems: [],
      timelineLimit: 20,
    });

    expect(replyItem?.replyTargetEventId).toBe("reply-id-2");
    expect(replyItem?.replyTargetPubkey).toBe(replyPubkey);
    expect(replyItem?.replyTargetRelayHints).toEqual([
      "wss://reply.example/",
      "wss://root.example/",
    ]);
  });

  it("treats the last positional e-tag as the direct reply target when three or more exist", () => {
    const rootPubkey = "b".repeat(64);
    const mentionPubkey = "c".repeat(64);
    const replyPubkey = "d".repeat(64);
    const replyEvent: NostrEvent = {
      id: "reply-id",
      pubkey: "a".repeat(64),
      created_at: 2,
      kind: 1,
      tags: [
        ["e", "root-id", "wss://root.example/", "", rootPubkey],
        ["e", "mention-id", "wss://mention.example/", "", mentionPubkey],
        ["e", "reply-id-3", "wss://reply.example/", "", replyPubkey],
        ["p", rootPubkey],
        ["p", mentionPubkey],
        ["p", replyPubkey],
      ],
      content: "reply",
      sig: "sig",
    };

    const [replyItem] = buildAuxiliaryTimeline({
      events: [replyEvent],
      profileSummaries: new Map(),
      referenceItems: [],
      timelineLimit: 20,
    });

    expect(replyItem?.replyTargetEventId).toBe("reply-id-3");
    expect(replyItem?.replyTargetPubkey).toBe(replyPubkey);
    expect(replyItem?.replyTargetRelayHints).toEqual([
      "wss://reply.example/",
      "wss://root.example/",
      "wss://mention.example/",
    ]);
  });

  it("preserves reply context when merging with relay snapshot items", () => {
    const currentItem: TimelineItem = {
      id: "reply-id",
      pubkey: "a".repeat(64),
      createdAt: 10,
      kind: 1,
      content: "reply",
      isReply: true,
      replyTargetEventId: "reply-target-id",
      replyTargetPubkey: "b".repeat(64),
      replyTargetProfile: {
        name: null,
        displayName: "Target User",
        picture: null,
      },
      replyContextPubkeys: ["b".repeat(64)],
      likeCount: 0,
      profile: null,
    };
    const snapshotItem: TimelineItem = {
      id: "reply-id",
      pubkey: "a".repeat(64),
      createdAt: 10,
      kind: 1,
      content: "reply",
      isReply: false,
      replyTargetEventId: null,
      replyTargetPubkey: null,
      replyTargetProfile: null,
      replyContextPubkeys: [],
      likeCount: 3,
      profile: null,
    };

    const [mergedItem] = mergeAuxiliaryTimeline({
      currentItems: [currentItem],
      includeItem: () => true,
      profileSummaries: new Map(),
      referenceItems: [snapshotItem],
      timelineLimit: 20,
    });

    expect(mergedItem?.isReply).toBe(true);
    expect(mergedItem?.replyTargetEventId).toBe(currentItem.replyTargetEventId);
    expect(mergedItem?.replyTargetPubkey).toBe(currentItem.replyTargetPubkey);
    expect(mergedItem?.replyContextPubkeys).toEqual(currentItem.replyContextPubkeys);
    expect(mergedItem?.likeCount).toBe(3);
  });

  it("preserves resolved notify target body when merging with raw reaction items", () => {
    const currentItem: TimelineItem = {
      id: "reaction-id",
      pubkey: "b".repeat(64),
      createdAt: 20,
      kind: 7,
      content: "target post",
      isReply: false,
      replyTargetPubkey: null,
      replyTargetProfile: null,
      replyContextPubkeys: [],
      likeCount: 2,
      profile: {
        name: null,
        displayName: "Target",
        picture: null,
      },
      notifyActorPubkey: "c".repeat(64),
      notifyActorProfile: {
        name: null,
        displayName: "Actor",
        picture: null,
      },
      notifyReactionContent: "😀",
      notifyTargetEventId: "target-id",
      notifyTargetResolved: true,
    };
    const snapshotItem: TimelineItem = {
      id: "reaction-id",
      pubkey: "c".repeat(64),
      createdAt: 20,
      kind: 7,
      content: "😀",
      isReply: false,
      replyTargetPubkey: null,
      replyTargetProfile: null,
      replyContextPubkeys: [],
      likeCount: 0,
      profile: null,
    };

    const [mergedItem] = mergeAuxiliaryTimeline({
      currentItems: [currentItem],
      includeItem: () => true,
      profileSummaries: new Map(),
      referenceItems: [snapshotItem],
      timelineLimit: 20,
    });

    expect(mergedItem?.pubkey).toBe(currentItem.pubkey);
    expect(mergedItem?.content).toBe(currentItem.content);
    expect(mergedItem?.notifyActorPubkey).toBe(currentItem.notifyActorPubkey);
    expect(mergedItem?.notifyTargetEventId).toBe(currentItem.notifyTargetEventId);
    expect(mergedItem?.notifyTargetResolved).toBe(true);
  });

  it("merges follow and account timelines without duplicating self posts", () => {
    const selfPost: TimelineItem = {
      id: "self-post",
      pubkey: "a".repeat(64),
      createdAt: 20,
      kind: 1,
      content: "self",
      isReply: false,
      replyTargetPubkey: null,
      replyTargetProfile: null,
      replyContextPubkeys: [],
      likeCount: 1,
      profile: null,
    };
    const followPost: TimelineItem = {
      id: "follow-post",
      pubkey: "b".repeat(64),
      createdAt: 30,
      kind: 1,
      content: "follow",
      isReply: false,
      replyTargetPubkey: null,
      replyTargetProfile: null,
      replyContextPubkeys: [],
      likeCount: 0,
      profile: null,
    };

    const items = buildVisibleTimeline({
      accountTimeline: [selfPost],
      followTimeline: [followPost, selfPost],
      notifyTimeline: [],
      overlayEventIds: [],
      profileSummaries: new Map(),
      reactionTimeline: [],
      timeline: [],
      timelineLimit: 20,
      timelineView: "follow",
    });

    expect(items.map((item) => item.id)).toEqual(["follow-post", "self-post"]);
  });

  it("shows reaction timeline when reaction view is selected", () => {
    const reactedPost: TimelineItem = {
      id: "reacted-post",
      pubkey: "c".repeat(64),
      createdAt: 40,
      kind: 1,
      content: "reacted",
      isReply: false,
      replyTargetPubkey: null,
      replyTargetProfile: null,
      replyContextPubkeys: [],
      likeCount: 4,
      profile: null,
    };

    const items = buildVisibleTimeline({
      accountTimeline: [],
      followTimeline: [],
      notifyTimeline: [],
      overlayEventIds: [],
      profileSummaries: new Map(),
      reactionTimeline: [reactedPost],
      timeline: [],
      timelineLimit: 20,
      timelineView: "reaction",
    });

    expect(items.map((item) => item.id)).toEqual(["reacted-post"]);
  });

  it("shows notify timeline when notify view is selected", () => {
    const notifyPost: TimelineItem = {
      id: "notify-post",
      pubkey: "d".repeat(64),
      createdAt: 50,
      kind: 1,
      content: "notify",
      isReply: true,
      replyTargetPubkey: "a".repeat(64),
      replyTargetProfile: null,
      replyContextPubkeys: ["a".repeat(64)],
      likeCount: 0,
      profile: null,
    };

    const items = buildVisibleTimeline({
      accountTimeline: [],
      followTimeline: [],
      notifyTimeline: [notifyPost],
      overlayEventIds: [],
      profileSummaries: new Map(),
      reactionTimeline: [],
      timeline: [],
      timelineLimit: 20,
      timelineView: "notify",
    });

    expect(items.map((item) => item.id)).toEqual(["notify-post"]);
  });
});
