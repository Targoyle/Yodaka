import type { AuxiliaryLoadState, TimelineView } from "../../app/types";
import { normalizeHexPubkey } from "./pubkey";
import type { NostrEvent } from "./relay";
import type {
  ReactionSummary,
  TimelineItem,
  TimelineProfile,
} from "../wasm/client";
import { profilesEqual } from "./profilePresentation";

export function buildVisibleTimeline(args: {
  accountTimeline: TimelineItem[];
  followTimeline: TimelineItem[];
  includeAccountTimelineInFollow: boolean;
  notifyTimeline: TimelineItem[];
  overlayEventIds: string[];
  profileSummaries: Map<string, TimelineProfile>;
  reactionTimeline: TimelineItem[];
  timeline: TimelineItem[];
  timelineLimit: number;
  timelineView: TimelineView;
}) {
  switch (args.timelineView) {
    case "follow":
      return attachProfilesToTimeline(
        mergePersonalTimelineItems(
          args.followTimeline,
          args.includeAccountTimelineInFollow ? args.accountTimeline : [],
          args.timelineLimit,
        ),
        args.profileSummaries,
      );

    case "reaction":
      return attachProfilesToTimeline(
        args.reactionTimeline.slice(0, args.timelineLimit),
        args.profileSummaries,
      );

    case "notify":
      return attachProfilesToTimeline(
        args.notifyTimeline.slice(0, args.timelineLimit),
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

export function buildFocusedThreadTimeline(args: {
  focusedItem: TimelineItem | null;
  referenceItems: TimelineItem[];
  timelineLimit: number;
}) {
  if (!args.focusedItem) {
    return [];
  }

  const focusedItem = args.focusedItem;
  const referenceById = new Map<string, TimelineItem>([
    [focusedItem.id, focusedItem],
  ]);

  for (const item of args.referenceItems) {
    if (!referenceById.has(item.id)) {
      referenceById.set(item.id, item);
    }
  }

  const descendants = [...referenceById.values()]
    .filter((item) => item.id !== focusedItem.id)
    .filter((item) => isFocusedThreadDescendant(item, focusedItem.id, referenceById))
    .sort(compareTimelineItemsDesc)
    .slice(0, Math.max(args.timelineLimit - 1, 0));

  return [focusedItem, ...descendants];
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
    const supportsReplyContext = event.kind === 1;
    const supportsRepostContext = event.kind === 6;
    const replyContextPubkeys = supportsReplyContext
      ? findReplyContextPubkeys(event, referenceById)
      : [];
    const replyTargetEventId = supportsReplyContext
      ? findReplyTargetEventId(event)
      : null;
    const replyTargetPubkey = supportsReplyContext
      ? findReplyTargetPubkey(
          event,
          referenceById,
          replyContextPubkeys,
        )
      : null;
    const replyTargetRelayHints = supportsReplyContext
      ? findReplyTargetRelayHints(event)
      : [];
    const replyTargetProfile = replyTargetPubkey
      ? args.profileSummaries.get(replyTargetPubkey) ?? existing?.replyTargetProfile ?? null
      : null;
    const repostTargetEventId = supportsRepostContext
      ? findRepostTargetEventId(event)
      : null;
    const repostTargetPubkey = supportsRepostContext
      ? findRepostTargetPubkey(event, referenceById)
      : null;
    const repostTargetRelayHints = supportsRepostContext
      ? findRepostTargetRelayHints(event)
      : [];
    const repostTargetProfile = repostTargetPubkey
      ? args.profileSummaries.get(repostTargetPubkey) ?? existing?.repostTargetProfile ?? null
      : null;

    if (existing) {
      items.set(
        event.id,
        existing.replyTargetEventId === replyTargetEventId
        && existing.replyTargetPubkey === replyTargetPubkey
        && replyTargetRelayHintsEqual(
          existing.replyTargetRelayHints ?? [],
          replyTargetRelayHints,
        )
        && profilesEqual(existing.replyTargetProfile, replyTargetProfile)
        && replyContextPubkeysEqual(existing.replyContextPubkeys, replyContextPubkeys)
        && (existing.repostTargetEventId ?? null) === repostTargetEventId
        && (existing.repostTargetPubkey ?? null) === repostTargetPubkey
        && repostTargetRelayHintsEqual(
          existing.repostTargetRelayHints ?? [],
          repostTargetRelayHints,
        )
        && profilesEqual(existing.repostTargetProfile ?? null, repostTargetProfile)
          ? existing
          : {
              ...existing,
              replyTargetEventId,
              replyTargetPubkey,
              replyTargetRelayHints,
              replyTargetProfile,
              replyContextPubkeys,
              repostTargetEventId,
              repostTargetPubkey,
              repostTargetRelayHints,
              repostTargetProfile,
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
      isReply: supportsReplyContext && event.tags.some((tag) => tag[0] === "e" || tag[0] === "a"),
      replyTargetEventId,
      replyTargetPubkey,
      replyTargetRelayHints,
      replyTargetProfile,
      replyContextPubkeys,
      repostTargetEventId,
      repostTargetPubkey,
      repostTargetRelayHints,
      repostTargetProfile,
      likeCount: 0,
      kusaCount: 0,
      moreReactionCount: 0,
      otherReactionSummaries: [],
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
    const replyTargetEventId =
      item.replyTargetEventId ?? currentItem?.replyTargetEventId ?? null;
    const replyTargetPubkey =
      item.replyTargetPubkey ?? currentItem?.replyTargetPubkey ?? null;
    const replyTargetRelayHints =
      item.replyTargetRelayHints && item.replyTargetRelayHints.length > 0
        ? item.replyTargetRelayHints
        : currentItem?.replyTargetRelayHints ?? [];
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
    const repostTargetEventId =
      item.repostTargetEventId ?? currentItem?.repostTargetEventId ?? null;
    const repostTargetPubkey =
      item.repostTargetPubkey ?? currentItem?.repostTargetPubkey ?? null;
    const repostTargetRelayHints =
      item.repostTargetRelayHints && item.repostTargetRelayHints.length > 0
        ? item.repostTargetRelayHints
        : currentItem?.repostTargetRelayHints ?? [];
    const latestRepostTargetProfile = repostTargetPubkey
      ? args.profileSummaries.get(repostTargetPubkey)
        ?? item.repostTargetProfile
        ?? currentItem?.repostTargetProfile
        ?? null
      : null;
    const isReply = item.isReply || currentItem?.isReply || false;
    const notifyActorPubkey =
      currentItem?.notifyActorPubkey ?? item.notifyActorPubkey ?? null;
    const notifyActorProfile = notifyActorPubkey
      ? args.profileSummaries.get(notifyActorPubkey)
        ?? currentItem?.notifyActorProfile
        ?? item.notifyActorProfile
        ?? null
      : null;
    const notifyReactionContent =
      currentItem?.notifyReactionContent ?? item.notifyReactionContent ?? null;
    const notifyTargetEventId =
      currentItem?.notifyTargetEventId ?? item.notifyTargetEventId ?? null;
    const notifyTargetResolved =
      currentItem?.notifyTargetResolved ?? item.notifyTargetResolved ?? false;
    const preserveResolvedNotifyBody =
      item.kind === 7
      && notifyTargetResolved
      && !item.notifyTargetResolved;
    const mergedItem: TimelineItem = {
      ...(preserveResolvedNotifyBody && currentItem ? currentItem : item),
      isReply,
      replyTargetEventId,
      replyTargetPubkey,
      replyTargetRelayHints,
      replyTargetProfile: latestReplyTargetProfile,
      replyContextPubkeys,
      repostTargetEventId,
      repostTargetPubkey,
      repostTargetRelayHints,
      repostTargetProfile: latestRepostTargetProfile,
      profile: latestProfile,
      notifyActorPubkey,
      notifyActorProfile,
      notifyReactionContent,
      notifyTargetEventId,
      notifyTargetResolved,
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
      && (currentItem.replyTargetEventId ?? null) === (mergedItem.replyTargetEventId ?? null)
      && currentItem.replyTargetPubkey === mergedItem.replyTargetPubkey
      && replyTargetRelayHintsEqual(
        currentItem.replyTargetRelayHints ?? [],
        mergedItem.replyTargetRelayHints ?? [],
      )
      && profilesEqual(currentItem.replyTargetProfile, mergedItem.replyTargetProfile)
      && replyContextPubkeysEqual(currentItem.replyContextPubkeys, mergedItem.replyContextPubkeys)
      && (currentItem.repostTargetEventId ?? null) === (mergedItem.repostTargetEventId ?? null)
      && (currentItem.repostTargetPubkey ?? null) === (mergedItem.repostTargetPubkey ?? null)
      && repostTargetRelayHintsEqual(
        currentItem.repostTargetRelayHints ?? [],
        mergedItem.repostTargetRelayHints ?? [],
      )
      && profilesEqual(currentItem.repostTargetProfile ?? null, mergedItem.repostTargetProfile ?? null)
      && currentItem.likeCount === mergedItem.likeCount
      && (currentItem.kusaCount ?? 0) === (mergedItem.kusaCount ?? 0)
      && (currentItem.moreReactionCount ?? 0) === (mergedItem.moreReactionCount ?? 0)
      && reactionSummariesEqual(
        currentItem.otherReactionSummaries ?? [],
        mergedItem.otherReactionSummaries ?? [],
      )
      && profilesEqual(currentItem.profile, mergedItem.profile)
      && currentItem.notifyActorPubkey === mergedItem.notifyActorPubkey
      && profilesEqual(currentItem.notifyActorProfile, mergedItem.notifyActorProfile)
      && currentItem.notifyReactionContent === mergedItem.notifyReactionContent
      && currentItem.notifyTargetEventId === mergedItem.notifyTargetEventId
      && (currentItem.notifyTargetResolved ?? false) === (mergedItem.notifyTargetResolved ?? false)
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
    const latestRepostTargetProfile = item.repostTargetPubkey
      ? profileSummaries.get(item.repostTargetPubkey) ?? item.repostTargetProfile ?? null
      : null;
    const latestNotifyActorProfile = item.notifyActorPubkey
      ? profileSummaries.get(item.notifyActorPubkey) ?? item.notifyActorProfile ?? null
      : null;

    if (
      profilesEqual(item.profile, latestProfile)
      && profilesEqual(item.replyTargetProfile, latestReplyTargetProfile)
      && profilesEqual(item.repostTargetProfile ?? null, latestRepostTargetProfile)
      && profilesEqual(item.notifyActorProfile, latestNotifyActorProfile)
    ) {
      return item;
    }

    return {
      ...item,
      profile: latestProfile,
      replyTargetProfile: latestReplyTargetProfile,
      repostTargetProfile: latestRepostTargetProfile,
      notifyActorProfile: latestNotifyActorProfile,
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
      || (leftItem.replyTargetEventId ?? null) !== (rightItem.replyTargetEventId ?? null)
      || leftItem.replyTargetPubkey !== rightItem.replyTargetPubkey
      || !replyTargetRelayHintsEqual(
        leftItem.replyTargetRelayHints ?? [],
        rightItem.replyTargetRelayHints ?? [],
      )
      || !profilesEqual(leftItem.replyTargetProfile, rightItem.replyTargetProfile)
      || !replyContextPubkeysEqual(
        leftItem.replyContextPubkeys,
        rightItem.replyContextPubkeys,
      )
      || (leftItem.repostTargetEventId ?? null) !== (rightItem.repostTargetEventId ?? null)
      || (leftItem.repostTargetPubkey ?? null) !== (rightItem.repostTargetPubkey ?? null)
      || !repostTargetRelayHintsEqual(
        leftItem.repostTargetRelayHints ?? [],
        rightItem.repostTargetRelayHints ?? [],
      )
      || !profilesEqual(leftItem.repostTargetProfile ?? null, rightItem.repostTargetProfile ?? null)
      || leftItem.likeCount !== rightItem.likeCount
      || (leftItem.kusaCount ?? 0) !== (rightItem.kusaCount ?? 0)
      || (leftItem.moreReactionCount ?? 0) !== (rightItem.moreReactionCount ?? 0)
      || !reactionSummariesEqual(
        leftItem.otherReactionSummaries ?? [],
        rightItem.otherReactionSummaries ?? [],
      )
      || !profilesEqual(leftItem.profile, rightItem.profile)
      || leftItem.notifyActorPubkey !== rightItem.notifyActorPubkey
      || !profilesEqual(leftItem.notifyActorProfile, rightItem.notifyActorProfile)
      || leftItem.notifyReactionContent !== rightItem.notifyReactionContent
      || leftItem.notifyTargetEventId !== rightItem.notifyTargetEventId
      || (leftItem.notifyTargetResolved ?? false) !== (rightItem.notifyTargetResolved ?? false)
    ) {
      return false;
    }
  }

  return true;
}

function findReplyTargetRelayHints(event: NostrEvent) {
  const relayHints: string[] = [];

  const pushRelayHint = (relayHint: string | undefined) => {
    const normalized = relayHint?.trim();

    if (!normalized || relayHints.includes(normalized)) {
      return;
    }

    relayHints.push(normalized);
  };

  const replyTargetTag = findReplyTargetEventTag(event);
  const rootTag = findRootEventTag(event);

  if (replyTargetTag) {
    pushRelayHint(replyTargetTag[2]);
  }

  if (rootTag && rootTag !== replyTargetTag) {
    pushRelayHint(rootTag[2]);
  }

  for (const tag of listEventReferenceTags(event)) {
    pushRelayHint(tag[2]);
  }

  return relayHints;
}

export function compareTimelineItemsDesc(left: TimelineItem, right: TimelineItem) {
  if (left.createdAt === right.createdAt) {
    return right.id.localeCompare(left.id);
  }

  return right.createdAt - left.createdAt;
}

function isFocusedThreadDescendant(
  item: TimelineItem,
  focusedEventId: string,
  referenceById: ReadonlyMap<string, TimelineItem>,
) {
  let current: TimelineItem | undefined = item;
  const seenEventIds = new Set<string>([item.id]);

  while (current?.replyTargetEventId) {
    if (current.replyTargetEventId === focusedEventId) {
      return true;
    }

    const next = referenceById.get(current.replyTargetEventId);

    if (!next || seenEventIds.has(next.id)) {
      return false;
    }

    seenEventIds.add(next.id);
    current = next;
  }

  return false;
}

function findReplyTargetPubkey(
  event: NostrEvent,
  referenceById: Map<string, TimelineItem>,
  replyContextPubkeys: string[],
) {
  const selfPubkey = normalizeHexPubkey(event.pubkey);
  const preferredReplyPTargetPubkey = findPreferredReplyPTargetPubkey(event);
  const replyTargetTag = findReplyTargetEventTag(event);

  if (replyTargetTag) {
    const replyTargetPubkey = normalizeTaggedPubkey(replyTargetTag[4]);

    if (
      replyTargetPubkey
      && replyTargetPubkey !== selfPubkey
    ) {
      return replyTargetPubkey;
    }

    if (replyTargetTag[1]) {
      const referencedItem = referenceById.get(replyTargetTag[1]);

      if (referencedItem?.pubkey && referencedItem.pubkey !== selfPubkey) {
        return referencedItem.pubkey;
      }
    }

    if (preferredReplyPTargetPubkey) {
      return preferredReplyPTargetPubkey;
    }

    if (replyTargetPubkey) {
      return replyTargetPubkey;
    }

    if (replyTargetTag[1]) {
      const referencedItem = referenceById.get(replyTargetTag[1]);

      if (referencedItem) {
        return referencedItem.pubkey;
      }
    }
  }

  const replyPTag = event.tags.find((tag) =>
    tag[0] === "p" && tag[3] === "reply",
  );

  if (replyPTag?.[1]) {
    return normalizeHexPubkey(replyPTag[1]);
  }

  return preferredReplyPTargetPubkey
    ?? preferNonSelfReplyContextPubkey(replyContextPubkeys, selfPubkey)
    ?? (replyContextPubkeys.length === 1 ? replyContextPubkeys[0] : null);
}

function findReplyTargetEventId(event: NostrEvent) {
  return findReplyTargetEventTag(event)?.[1] ?? null;
}

function findRepostTargetEventTag(event: NostrEvent) {
  return listEventReferenceTags(event)[0] ?? null;
}

function findRepostTargetEventId(event: NostrEvent) {
  return findRepostTargetEventTag(event)?.[1] ?? null;
}

function findRepostTargetRelayHints(event: NostrEvent) {
  const relayHints: string[] = [];

  const pushRelayHint = (relayHint: string | undefined) => {
    const normalized = relayHint?.trim();

    if (!normalized || relayHints.includes(normalized)) {
      return;
    }

    relayHints.push(normalized);
  };

  const repostTargetTag = findRepostTargetEventTag(event);

  if (repostTargetTag) {
    pushRelayHint(repostTargetTag[2]);
  }

  for (const tag of listEventReferenceTags(event)) {
    pushRelayHint(tag[2]);
  }

  return relayHints;
}

function findRepostTargetPubkey(
  event: NostrEvent,
  referenceById: Map<string, TimelineItem>,
) {
  const repostPTag = event.tags.find((tag) => tag[0] === "p");

  if (repostPTag?.[1]) {
    return normalizeHexPubkey(repostPTag[1]);
  }

  const repostTargetEventId = findRepostTargetEventId(event);

  if (!repostTargetEventId) {
    return null;
  }

  return referenceById.get(repostTargetEventId)?.pubkey ?? null;
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

  return sortReplyContextPubkeys(candidates, normalizeHexPubkey(event.pubkey));
}

function findReplyEventTag(event: NostrEvent) {
  return event.tags.find((tag) =>
    tag[0] === "e" && tag[3] === "reply",
  );
}

function findRootEventTag(event: NostrEvent) {
  return event.tags.find((tag) =>
    tag[0] === "e" && tag[3] === "root",
  );
}

function listEventReferenceTags(event: NostrEvent) {
  return event.tags.filter((tag) => tag[0] === "e" && tag[1]);
}

function findPositionalReplyEventTag(event: NostrEvent) {
  const eventReferenceTags = listEventReferenceTags(event);

  if (eventReferenceTags.length === 0) {
    return null;
  }

  if (eventReferenceTags.length === 1) {
    return eventReferenceTags[0];
  }

  if (eventReferenceTags.length === 2) {
    return eventReferenceTags[1];
  }

  return eventReferenceTags.at(-1) ?? null;
}

function findReplyTargetEventTag(event: NostrEvent) {
  return findReplyEventTag(event)
    ?? findRootEventTag(event)
    ?? findPositionalReplyEventTag(event);
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
  const selfPubkeys = pubkeys.filter((pubkey) => pubkey === selfPubkey);

  return [...nonSelfPubkeys, ...selfPubkeys];
}

function sortReplyContextPubkeys(pubkeys: string[], selfPubkey: string) {
  return excludeSelfReplyContextPubkeys(pubkeys, selfPubkey);
}

function preferNonSelfReplyContextPubkey(
  pubkeys: string[],
  selfPubkey: string,
) {
  return pubkeys.find((pubkey) => pubkey !== selfPubkey) ?? pubkeys[0] ?? null;
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

function replyTargetRelayHintsEqual(left: string[], right: string[]) {
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

function repostTargetRelayHintsEqual(left: string[], right: string[]) {
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

function reactionSummariesEqual(left: ReactionSummary[], right: ReactionSummary[]) {
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
      || leftItem.content !== rightItem.content
      || leftItem.count !== rightItem.count
    ) {
      return false;
    }
  }

  return true;
}

function isResolvedNotifyTargetBody(item: TimelineItem | undefined) {
  return item?.notifyTargetResolved ?? false;
}

export function buildTimelineEmptyMessage(
  timelineView: TimelineView,
  followLoadState: AuxiliaryLoadState,
  accountLoadState: AuxiliaryLoadState,
  notifyLoadState: AuxiliaryLoadState,
  reactionLoadState: AuxiliaryLoadState,
  followCount: number,
  notifyCount: number,
  reactionCount: number,
  accountError: string | null,
  followError: string | null,
  notifyError: string | null,
  reactionError: string | null,
) {
  if (timelineView === "relay") {
    return "直近のポストはありません。";
  }

  if (timelineView === "notify") {
    if (notifyCount > 0) {
      return "直近の通知はありません。";
    }

    switch (notifyLoadState) {
      case "waiting":
        return "read relay 接続待ち...";

      case "loading":
        return "通知読み込み中...";

      case "error":
        return notifyError ?? "notify を取得できませんでした。";

      default:
        return "直近の通知はありません。";
    }
  }

  if (timelineView === "reaction") {
    if (reactionCount > 0) {
      return "直近のポストはありません。";
    }

    switch (reactionLoadState) {
      case "waiting":
        return "read relay 接続待ち...";

      case "loading":
        return "リアクション読み込み中...";

      case "error":
        return reactionError ?? "reaction を取得できませんでした。";

      default:
        return "直近のリアクションはありません。";
    }
  }

  if (timelineView === "account") {
    switch (accountLoadState) {
      case "waiting":
        return "read relay 接続待ち...";

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

  if (followLoadState === "waiting" || accountLoadState === "waiting") {
    return "read relay 接続待ち...";
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
