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
    expect(replyItem?.replyTargetProfile?.displayName).toBe("Root User");
    expect(replyItem?.replyContextPubkeys).toEqual([rootItem.pubkey]);
  });

  it("prefers reply e-tag author and excludes self from reply bands", () => {
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
    expect(replyItem?.replyContextPubkeys).toEqual([replyTargetPubkey]);
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
    expect(replyItem?.replyContextPubkeys).toEqual([rootPubkey]);
  });

  it("preserves reply context when merging with relay snapshot items", () => {
    const currentItem: TimelineItem = {
      id: "reply-id",
      pubkey: "a".repeat(64),
      createdAt: 10,
      kind: 1,
      content: "reply",
      isReply: true,
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
