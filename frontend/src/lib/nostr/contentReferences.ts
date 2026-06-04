import {
  decodeNaddr,
  decodeNevent,
  decodeNote,
  decodeNprofile,
  decodeNpub,
  encodeNpub,
} from "./nip19";

export type ContentEventReference = {
  type: "event";
  identifier: string;
  displayText: string;
  eventId: string;
  relayUrls: string[];
  authorPubkey: string | null;
};

export type ContentProfileReference = {
  type: "profile";
  identifier: string;
  displayText: string;
  pubkey: string;
  relayUrls: string[];
};

export type ContentAddressReference = {
  type: "address";
  identifier: string;
  displayText: string;
  address: string;
  pubkey: string;
  kind: number;
  relayUrls: string[];
};

export type ParsedContentReference =
  | ContentEventReference
  | ContentProfileReference
  | ContentAddressReference;

const CONTENT_REFERENCE_TOKEN_RE =
  /(?:nostr:)?(?:npub|note|nevent|nprofile|naddr)1[ac-hj-np-z02-9]{8,}/giu;

export function normalizeContentNostrUris(content: string) {
  let cursor = 0;
  let normalizedContent = "";

  for (const match of content.matchAll(CONTENT_REFERENCE_TOKEN_RE)) {
    const token = match[0] ?? "";
    const start = match.index ?? -1;

    if (!token || start < cursor) {
      continue;
    }

    normalizedContent += content.slice(cursor, start);

    const parsed = parseContentReferenceToken(token);
    normalizedContent += parsed && !/^nostr:/iu.test(token)
      ? `nostr:${parsed.identifier}`
      : token;
    cursor = start + token.length;
  }

  if (cursor < content.length) {
    normalizedContent += content.slice(cursor);
  }

  return normalizedContent;
}

export function parseContentReferenceToken(token: string): ParsedContentReference | null {
  const identifier = token.replace(/^nostr:/iu, "");
  const normalizedIdentifier = identifier.toLowerCase();
  const decodedEvent = normalizedIdentifier.startsWith("nevent1")
    ? decodeNevent(identifier)
    : null;

  if (decodedEvent) {
    return {
      type: "event",
      identifier,
      displayText: identifier,
      eventId: decodedEvent.eventId,
      relayUrls: [...decodedEvent.relayUrls],
      authorPubkey: decodedEvent.authorPubkey,
    };
  }

  const decodedNote = normalizedIdentifier.startsWith("note1")
    ? decodeNote(identifier)
    : null;

  if (decodedNote) {
    return {
      type: "event",
      identifier,
      displayText: identifier,
      eventId: decodedNote,
      relayUrls: [],
      authorPubkey: null,
    };
  }

  const decodedNprofile = normalizedIdentifier.startsWith("nprofile1")
    ? decodeNprofile(identifier)
    : null;

  if (decodedNprofile) {
    return {
      type: "profile",
      identifier,
      displayText: encodeNpub(decodedNprofile.pubkey) ?? identifier,
      pubkey: decodedNprofile.pubkey,
      relayUrls: [...decodedNprofile.relayUrls],
    };
  }

  const decodedNpub = normalizedIdentifier.startsWith("npub1")
    ? decodeNpub(identifier)
    : null;

  if (decodedNpub) {
    return {
      type: "profile",
      identifier,
      displayText: identifier,
      pubkey: decodedNpub,
      relayUrls: [],
    };
  }

  const decodedNaddr = normalizedIdentifier.startsWith("naddr1")
    ? decodeNaddr(identifier)
    : null;

  if (decodedNaddr) {
    return {
      type: "address",
      identifier,
      displayText: identifier,
      address: `${decodedNaddr.kind}:${decodedNaddr.pubkey}:${decodedNaddr.identifier}`,
      pubkey: decodedNaddr.pubkey,
      kind: decodedNaddr.kind,
      relayUrls: [...decodedNaddr.relayUrls],
    };
  }

  return null;
}

export function extractContentEventReferences(content: string) {
  const referencesById = new Map<string, ContentEventReference>();

  for (const reference of listContentReferences(content)) {
    if (reference.type !== "event") {
      continue;
    }

    const current = referencesById.get(reference.eventId);

    if (!current) {
      referencesById.set(reference.eventId, {
        ...reference,
        relayUrls: [...reference.relayUrls],
      });
      continue;
    }

    current.relayUrls = mergeRelayUrls(current.relayUrls, reference.relayUrls);
    current.authorPubkey ??= reference.authorPubkey;
  }

  return [...referencesById.values()];
}

export function extractContentProfileReferences(content: string) {
  const referencesByPubkey = new Map<string, ContentProfileReference>();

  for (const reference of listContentReferences(content)) {
    if (reference.type !== "profile") {
      continue;
    }

    const current = referencesByPubkey.get(reference.pubkey);

    if (!current) {
      referencesByPubkey.set(reference.pubkey, {
        ...reference,
        relayUrls: [...reference.relayUrls],
      });
      continue;
    }

    current.relayUrls = mergeRelayUrls(current.relayUrls, reference.relayUrls);
  }

  return [...referencesByPubkey.values()];
}

export function extractContentAddressReferences(content: string) {
  const referencesByAddress = new Map<string, ContentAddressReference>();

  for (const reference of listContentReferences(content)) {
    if (reference.type !== "address") {
      continue;
    }

    const current = referencesByAddress.get(reference.address);

    if (!current) {
      referencesByAddress.set(reference.address, {
        ...reference,
        relayUrls: [...reference.relayUrls],
      });
      continue;
    }

    current.relayUrls = mergeRelayUrls(current.relayUrls, reference.relayUrls);
  }

  return [...referencesByAddress.values()];
}

function listContentReferences(content: string) {
  const references: ParsedContentReference[] = [];

  for (const match of content.matchAll(CONTENT_REFERENCE_TOKEN_RE)) {
    const parsed = parseContentReferenceToken(match[0] ?? "");

    if (parsed) {
      references.push(parsed);
    }
  }

  return references;
}

function mergeRelayUrls(left: string[], right: string[]) {
  return [...new Set([...left, ...right])];
}
