import type { AuxiliaryLoadState, TimelineView } from "../../app/types";
import { normalizeHexPubkey } from "./pubkey";
import type { NostrEvent } from "./relay";
import type { TimelineItem, TimelineProfile } from "../wasm/client";
import { profilesEqual } from "./profilePresentation";

export function buildVisibleTimeline(args: {
  accountTimeline: TimelineItem[];
  followTimeline: TimelineItem[];
  overlayEventIds: string[];
  profileSummaries: Map<string, TimelineProfile>;
  timeline: TimelineItem[];
  timelineLimit: number;
  timelineView: TimelineView;
}) {
  switch (args.timelineView) {
    case "follow":
      return attachProfilesToTimeline(
        mergePersonalTimelineItems(
          args.followTimeline,
          args.accountTimeline,
          args.timelineLimit,
        ),
        args.profileSummaries,
      );

    case "account":
      return attachProfilesToTimeline(
        args.accountTimeline.slice(0, args.timelineLimit),
        args.profileSummaries,
      );

    case "relay":
      return attachProfilesToTimeline(
        args.timeline
          .filter((item) => !args.overlayEventIds.includes(item.id))
          .slice(0, args.timelineLimit),
        args.profileSummaries,
      );
  }
}

export function mergePersonalTimelineItems(
  followTimeline: TimelineItem[],
  accountTimeline: TimelineItem[],
  timelineLimit: number,
) {
  const mergedById = new Map<string, TimelineItem>();

  for (const item of [...followTimeline, ...accountTimeline].sort(compareTimelineItemsDesc)) {
    if (mergedById.has(item.id)) {
      continue;
    }

    mergedById.set(item.id, item);

    if (mergedById.size >= timelineLimit) {
      break;
    }
  }

  return [...mergedById.values()];
}

export function buildAuxiliaryTimeline(args: {
  events: NostrEvent[];
  profileSummaries: Map<string, TimelineProfile>;
  referenceItems: TimelineItem[];
  timelineLimit: number;
}) {
  const referenceById = new Map(args.referenceItems.map((item) => [item.id, item]));
  const items = new Map<string, TimelineItem>();

  for (const event of args.events) {
    const normalizedPubkey = normalizeHexPubkey(event.pubkey);
    const existing = referenceById.get(event.id);
    const replyContextPubkeys = findReplyContextPubkeys(event, referenceById);
    const replyTargetPubkey = findReplyTargetPubkey(
      event,
      referenceById,
      replyContextPubkeys,
    );
    const replyTargetProfile = replyTargetPubkey
      ? args.profileSummaries.get(replyTargetPubkey) ?? existing?.replyTargetProfile ?? null
      : null;

    if (existing) {
      items.set(
        event.id,
        existing.replyTargetPubkey === replyTargetPubkey
        && profilesEqual(existing.replyTargetProfile, replyTargetProfile)
        && replyContextPubkeysEqual(existing.replyContextPubkeys, replyContextPubkeys)
          ? existing
          : {
              ...existing,
              replyTargetPubkey,
              replyTargetProfile,
              replyContextPubkeys,
            },
      );
      continue;
    }

    items.set(event.id, {
      id: event.id,
      pubkey: normalizedPubkey,
      createdAt: event.created_at,
      kind: event.kind,
      content: event.content,
      isReply: event.tags.some((tag) => tag[0] === "e" || tag[0] === "a"),
      replyTargetPubkey,
      replyTargetProfile,
      replyContextPubkeys,
      likeCount: 0,
      profile: args.profileSummaries.get(normalizedPubkey) ?? null,
    });
  }

  return [...items.values()]
    .sort(compareTimelineItemsDesc)
    .slice(0, args.timelineLimit);
}

export function mergeAuxiliaryTimeline(args: {
  currentItems: TimelineItem[];
  includeItem: (item: TimelineItem) => boolean;
  profileSummaries: Map<string, TimelineProfile>;
  referenceItems: TimelineItem[];
  timelineLimit: number;
}) {
  const items = new Map<string, TimelineItem>();

  for (const item of args.currentItems) {
    if (!args.includeItem(item)) {
      continue;
    }

    items.set(item.id, item);
  }

  for (const item of args.referenceItems) {
    if (!args.includeItem(item)) {
      continue;
    }

    const currentItem = items.get(item.id);
    const latestProfile = args.profileSummaries.get(item.pubkey) ?? item.profile;
    const replyTargetPubkey =
      item.replyTargetPubkey ?? currentItem?.replyTargetPubkey ?? null;
    const latestReplyTargetProfile = replyTargetPubkey
      ? args.profileSummaries.get(replyTargetPubkey)
        ?? item.replyTargetProfile
        ?? currentItem?.replyTargetProfile
        ?? null
      : null;
    const replyContextPubkeys =
      item.replyContextPubkeys.length > 0
        ? item.replyContextPubkeys
        : currentItem?.replyContextPubkeys ?? [];
    const isReply = item.isReply || currentItem?.isReply || false;
    const mergedItem: TimelineItem = {
      ...item,
      isReply,
      replyTargetPubkey,
      replyTargetProfile: latestReplyTargetProfile,
      replyContextPubkeys,
      profile: latestProfile,
    };

    items.set(
      item.id,
      currentItem
      && currentItem.id === mergedItem.id
      && currentItem.pubkey === mergedItem.pubkey
      && currentItem.createdAt === mergedItem.createdAt
      && currentItem.kind === mergedItem.kind
      && currentItem.content === mergedItem.content
      && currentItem.isReply === mergedItem.isReply
      && currentItem.replyTargetPubkey === mergedItem.replyTargetPubkey
      && profilesEqual(currentItem.replyTargetProfile, mergedItem.replyTargetProfile)
      && replyContextPubkeysEqual(currentItem.replyContextPubkeys, mergedItem.replyContextPubkeys)
      && currentItem.likeCount === mergedItem.likeCount
      && profilesEqual(currentItem.profile, mergedItem.profile)
        ? currentItem
        : mergedItem,
    );
  }

  return [...items.values()]
    .sort(compareTimelineItemsDesc)
    .slice(0, args.timelineLimit);
}

export function attachProfilesToTimeline(
  items: TimelineItem[],
  profileSummaries: Map<string, TimelineProfile>,
) {
  return items.map((item) => {
    const latestProfile = profileSummaries.get(item.pubkey) ?? item.profile;
    const latestReplyTargetProfile = item.replyTargetPubkey
      ? profileSummaries.get(item.replyTargetPubkey) ?? item.replyTargetProfile
      : null;

    if (
      profilesEqual(item.profile, latestProfile)
      && profilesEqual(item.replyTargetProfile, latestReplyTargetProfile)
    ) {
      return item;
    }

    return {
      ...item,
      profile: latestProfile,
      replyTargetProfile: latestReplyTargetProfile,
    };
  });
}

export function timelineItemsEqual(left: TimelineItem[], right: TimelineItem[]) {
  if (left === right) {
    return true;
  }

  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const leftItem = left[index];
    const rightItem = right[index];

    if (
      !leftItem
      || !rightItem
      || leftItem.id !== rightItem.id
      || leftItem.pubkey !== rightItem.pubkey
      || leftItem.createdAt !== rightItem.createdAt
      || leftItem.kind !== rightItem.kind
      || leftItem.content !== rightItem.content
      || leftItem.isReply !== rightItem.isReply
      || leftItem.replyTargetPubkey !== rightItem.replyTargetPubkey
      || !profilesEqual(leftItem.replyTargetProfile, rightItem.replyTargetProfile)
      || !replyContextPubkeysEqual(
        leftItem.replyContextPubkeys,
        rightItem.replyContextPubkeys,
      )
      || leftItem.likeCount !== rightItem.likeCount
      || !profilesEqual(leftItem.profile, rightItem.profile)
    ) {
      return false;
    }
  }

  return true;
}

export function compareTimelineItemsDesc(left: TimelineItem, right: TimelineItem) {
  if (left.createdAt === right.createdAt) {
    return right.id.localeCompare(left.id);
  }

  return right.createdAt - left.createdAt;
}

function findReplyTargetPubkey(
  event: NostrEvent,
  referenceById: Map<string, TimelineItem>,
  replyContextPubkeys: string[],
) {
  const replyTag = findReplyEventTag(event);

  if (!replyTag) {
    return replyContextPubkeys.length === 1 ? replyContextPubkeys[0] : null;
  }

  const replyTargetPubkey = normalizeTaggedPubkey(replyTag[4]);

  if (replyTargetPubkey) {
    return replyTargetPubkey;
  }

  if (replyTag[1]) {
    const referencedItem = referenceById.get(replyTag[1]);

    if (referencedItem) {
      return referencedItem.pubkey;
    }
  }

  const replyPTag = event.tags.find((tag) =>
    tag[0] === "p" && tag[3] === "reply",
  );

  if (replyPTag?.[1]) {
    return normalizeHexPubkey(replyPTag[1]);
  }

  return findPreferredReplyPTargetPubkey(event)
    ?? (replyContextPubkeys.length === 1 ? replyContextPubkeys[0] : null);
}

function findReplyContextPubkeys(
  event: NostrEvent,
  referenceById: Map<string, TimelineItem>,
) {
  const candidates: string[] = [];

  for (const tag of event.tags) {
    if (tag[0] !== "e") {
      continue;
    }

    pushReplyContextPubkey(candidates, normalizeTaggedPubkey(tag[4]));

    if (tag[1]) {
      pushReplyContextPubkey(candidates, referenceById.get(tag[1])?.pubkey ?? null);
    }
  }

  for (const tag of event.tags) {
    if (tag[0] !== "p") {
      continue;
    }

    pushReplyContextPubkey(candidates, normalizeTaggedPubkey(tag[1]));
  }

  return excludeSelfReplyContextPubkeys(candidates, normalizeHexPubkey(event.pubkey));
}

function findReplyEventTag(event: NostrEvent) {
  return event.tags.find((tag) =>
    tag[0] === "e" && tag[3] === "reply",
  );
}

function normalizeTaggedPubkey(value: string | undefined) {
  if (!value) {
    return null;
  }

  return normalizeHexPubkey(value);
}

function pushReplyContextPubkey(target: string[], pubkey: string | null) {
  if (!pubkey || target.includes(pubkey)) {
    return;
  }

  target.push(pubkey);
}

function excludeSelfReplyContextPubkeys(pubkeys: string[], selfPubkey: string) {
  const nonSelfPubkeys = pubkeys.filter((pubkey) => pubkey !== selfPubkey);

  return nonSelfPubkeys.length > 0 ? nonSelfPubkeys : pubkeys;
}

function findPreferredReplyPTargetPubkey(event: NostrEvent) {
  const pTags = event.tags
    .filter((tag) => tag[0] === "p")
    .map((tag) => normalizeTaggedPubkey(tag[1]))
    .filter((value): value is string => value !== null);

  const nonSelfPubkey = pTags.find((pubkey) => pubkey !== normalizeHexPubkey(event.pubkey));

  return nonSelfPubkey ?? pTags[0] ?? null;
}

function replyContextPubkeysEqual(left: string[], right: string[]) {
  if (left === right) {
    return true;
  }

  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

export function buildTimelineEmptyMessage(
  timelineView: TimelineView,
  followLoadState: AuxiliaryLoadState,
  accountLoadState: AuxiliaryLoadState,
  followCount: number,
  accountError: string | null,
  followError: string | null,
) {
  if (timelineView === "relay") {
    return "直近のポストはありません。";
  }

  if (timelineView === "account") {
    switch (accountLoadState) {
      case "loading":
        return "タイムライン読み込み中...";

      case "error":
        return accountError ?? "account を取得できませんでした。";

      default:
        return "直近のポストはありません。";
    }
  }

  if (followLoadState === "ready" && accountLoadState === "ready" && followCount === 0) {
    return "直近のポストはありません。";
  }

  if (followCount > 0) {
    return "直近のポストはありません。";
  }

  if (followLoadState === "loading" || accountLoadState === "loading") {
    return "タイムライン読み込み中...";
  }

  if (followLoadState === "error" && accountLoadState === "error") {
    return followError ?? accountError ?? "follow を取得できませんでした。";
  }

  switch (followLoadState) {
    case "error":
      return followError ?? "follow を取得できませんでした。";

    default:
      return accountLoadState === "error"
        ? accountError ?? "account を取得できませんでした。"
        : "直近のポストはありません。";
  }
}
