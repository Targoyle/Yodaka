import {
  extractContentAddressReferences,
  extractContentEventReferences,
  extractContentProfileReferences,
  normalizeContentNostrUris,
} from "./contentReferences";
import { normalizeHexPubkey } from "./pubkey";
import type { TimelineItem } from "../wasm/client";

type EventTagReference = {
  eventId: string;
  pubkey: string | null;
  relayHints: string[];
};

export function prepareTextNotePublish(args: {
  content: string;
  referenceItemsById: ReadonlyMap<string, TimelineItem>;
  replyTargetItem: TimelineItem | null;
}) {
  const normalizedContent = normalizeContentNostrUris(args.content);
  const pTagsByPubkey = new Map<string, string>();
  const qTags: string[][] = [];

  const eTags = args.replyTargetItem
    ? buildReplyEventTags(args.replyTargetItem, args.referenceItemsById)
    : [];

  if (args.replyTargetItem) {
    rememberPTag(pTagsByPubkey, args.replyTargetItem.pubkey);

    if (args.replyTargetItem.replyTargetPubkey) {
      rememberPTag(pTagsByPubkey, args.replyTargetItem.replyTargetPubkey);
    }

    for (const pubkey of args.replyTargetItem.replyContextPubkeys) {
      rememberPTag(pTagsByPubkey, pubkey);
    }
  }

  for (const reference of extractContentProfileReferences(normalizedContent)) {
    rememberPTag(pTagsByPubkey, reference.pubkey, reference.relayUrls);
  }

  for (const reference of extractContentEventReferences(normalizedContent)) {
    pushQTag(qTags, reference.eventId, reference.relayUrls, reference.authorPubkey);

    if (reference.authorPubkey) {
      rememberPTag(pTagsByPubkey, reference.authorPubkey, reference.relayUrls);
    }
  }

  for (const reference of extractContentAddressReferences(normalizedContent)) {
    pushQTag(qTags, reference.address, reference.relayUrls, null);
    rememberPTag(pTagsByPubkey, reference.pubkey, reference.relayUrls);
  }

  return {
    content: normalizedContent,
    tags: [
      ...eTags,
      ...[...pTagsByPubkey.entries()].map(([pubkey, relayUrl]) => (
        relayUrl ? ["p", pubkey, relayUrl] : ["p", pubkey]
      )),
      ...qTags,
    ],
  };
}

function buildReplyEventTags(
  replyTargetItem: TimelineItem,
  referenceItemsById: ReadonlyMap<string, TimelineItem>,
) {
  const directParent: EventTagReference = {
    eventId: replyTargetItem.id,
    pubkey: replyTargetItem.pubkey,
    relayHints: [],
  };
  const root = resolveReplyRootReference(replyTargetItem, referenceItemsById);

  if (root.eventId === directParent.eventId) {
    return [
      buildEventReferenceTag(root, "root"),
    ];
  }

  return [
    buildEventReferenceTag(root, "root"),
    buildEventReferenceTag(directParent, "reply"),
  ];
}

function resolveReplyRootReference(
  replyTargetItem: TimelineItem,
  referenceItemsById: ReadonlyMap<string, TimelineItem>,
) {
  let root: EventTagReference = {
    eventId: replyTargetItem.id,
    pubkey: replyTargetItem.pubkey,
    relayHints: [],
  };
  let currentItem: TimelineItem | null = replyTargetItem;
  const seenEventIds = new Set<string>([replyTargetItem.id]);

  while (currentItem?.replyTargetEventId) {
    root = {
      eventId: currentItem.replyTargetEventId,
      pubkey: currentItem.replyTargetPubkey ?? null,
      relayHints: [...(currentItem.replyTargetRelayHints ?? [])],
    };

    const nextItem: TimelineItem | null =
      referenceItemsById.get(currentItem.replyTargetEventId) ?? null;

    if (!nextItem || seenEventIds.has(nextItem.id)) {
      break;
    }

    seenEventIds.add(nextItem.id);
    currentItem = nextItem;
  }

  return root;
}

function buildEventReferenceTag(reference: EventTagReference, marker: "root" | "reply") {
  const relayUrl = firstRelayHint(reference.relayHints);
  const tag = ["e", reference.eventId];

  if (relayUrl || marker || reference.pubkey) {
    tag.push(relayUrl ?? "");
  }

  if (marker || reference.pubkey) {
    tag.push(marker);
  }

  if (reference.pubkey) {
    tag.push(reference.pubkey);
  }

  return tag;
}

function pushQTag(
  tags: string[][],
  target: string,
  relayHints: string[],
  authorPubkey: string | null,
) {
  const relayUrl = firstRelayHint(relayHints);
  const tag = ["q", target];

  if (relayUrl || authorPubkey) {
    tag.push(relayUrl ?? "");
  }

  if (authorPubkey) {
    if (tag.length === 2) {
      tag.push("");
    }

    tag.push(authorPubkey);
  }

  const key = JSON.stringify(tag);

  if (tags.some((existing) => JSON.stringify(existing) === key)) {
    return;
  }

  tags.push(tag);
}

function rememberPTag(
  tagsByPubkey: Map<string, string>,
  pubkey: string | null | undefined,
  relayHints: string[] = [],
) {
  const normalizedPubkey = normalizeHexPubkey(pubkey ?? "");

  if (!/^[0-9a-f]{64}$/.test(normalizedPubkey)) {
    return;
  }

  const relayUrl = firstRelayHint(relayHints) ?? "";
  const currentRelayUrl = tagsByPubkey.get(normalizedPubkey);

  if (currentRelayUrl === undefined) {
    tagsByPubkey.set(normalizedPubkey, relayUrl);
    return;
  }

  if (!currentRelayUrl && relayUrl) {
    tagsByPubkey.set(normalizedPubkey, relayUrl);
  }
}

function firstRelayHint(relayHints: string[]) {
  return relayHints.find((relayHint) => relayHint.trim().length > 0) ?? null;
}
