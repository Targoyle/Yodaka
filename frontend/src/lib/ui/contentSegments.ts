import {
  type ContentEventReference,
  type ContentProfileReference,
  parseContentReferenceToken,
} from "../nostr/contentReferences";

export type ContentSegment =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "url";
      text: string;
      href: string;
    }
  | {
      type: "nostr";
      text: string;
      href: string;
    }
  | {
      type: "event";
      text: string;
      identifier: string;
      eventId: string;
      relayUrls: string[];
      authorPubkey: string | null;
    }
  | {
      type: "mention";
      text: string;
      identifier: string;
      pubkey: string;
      relayUrls: string[];
    };

const INLINE_CONTENT_TOKEN_RE =
  /https?:\/\/[^\s<>"']+|(?:nostr:)?(?:npub|note|nevent|nprofile|naddr)1[ac-hj-np-z02-9]{8,}/giu;
const TRAILING_URL_PUNCTUATION_RE = /[)\]}>:.,;!?、。．，」』】）》]+$/u;

export function parseContentSegments(content: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  let cursor = 0;

  for (const match of content.matchAll(INLINE_CONTENT_TOKEN_RE)) {
    const token = match[0] ?? "";
    const start = match.index ?? -1;

    if (!token || start < cursor) {
      continue;
    }

    if (start > cursor) {
      pushTextSegment(segments, content.slice(cursor, start));
    }

    segments.push(...tokenizeContentToken(token));
    cursor = start + token.length;
  }

  if (cursor < content.length) {
    pushTextSegment(segments, content.slice(cursor));
  }

  return segments;
}

function tokenizeContentToken(token: string): ContentSegment[] {
  if (/^https?:\/\//iu.test(token)) {
    return tokenizeUrlToken(token);
  }

  const parsedReference = parseContentReferenceToken(token);

  if (parsedReference?.type === "event") {
    return tokenizeNostrToken(token);
  }

  if (parsedReference?.type === "profile") {
    return [
      {
        type: "mention",
        text: parsedReference.displayText,
        identifier: parsedReference.identifier,
        pubkey: parsedReference.pubkey,
        relayUrls: [...parsedReference.relayUrls],
      },
    ];
  }

  if (/^nostr:/iu.test(token)) {
    return tokenizeNostrToken(token);
  }

  return [
    {
      type: "text",
      text: token,
    },
  ];
}

function tokenizeUrlToken(token: string): ContentSegment[] {
  const href = trimTrailingUrlPunctuation(token);

  if (!href || !isHttpUrl(href)) {
    return [
      {
        type: "text",
        text: token,
      },
    ];
  }

  const trailingText = token.slice(href.length);
  const segments: ContentSegment[] = [
    {
      type: "url",
      text: href,
      href,
    },
  ];

  if (trailingText) {
    segments.push({
      type: "text",
      text: trailingText,
    });
  }

  return segments;
}

function tokenizeNostrToken(token: string): ContentSegment[] {
  const parsedReference = parseContentReferenceToken(token);

  if (parsedReference?.type === "event") {
    return [
      {
        type: "event",
        text: parsedReference.displayText,
        identifier: parsedReference.identifier,
        eventId: parsedReference.eventId,
        relayUrls: [...parsedReference.relayUrls],
        authorPubkey: parsedReference.authorPubkey,
      },
    ];
  }

  if (parsedReference?.type === "profile") {
    return [
      {
        type: "mention",
        text: parsedReference.displayText,
        identifier: parsedReference.identifier,
        pubkey: parsedReference.pubkey,
        relayUrls: [...parsedReference.relayUrls],
      },
    ];
  }

  return [
    {
      type: "nostr",
      text: token.slice("nostr:".length),
      href: token,
    },
  ];
}

function trimTrailingUrlPunctuation(token: string) {
  return token.replace(TRAILING_URL_PUNCTUATION_RE, "");
}

function isHttpUrl(value: string) {
  try {
    const parsed = new URL(value);

    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function pushTextSegment(segments: ContentSegment[], text: string) {
  if (!text) {
    return;
  }

  const previous = segments.at(-1);

  if (previous?.type === "text") {
    previous.text += text;
    return;
  }

  segments.push({
    type: "text",
    text,
  });
}

export function extractContentEventReferences(content: string): ContentEventReference[] {
  const referencesById = new Map<string, ContentEventReference>();

  for (const segment of parseContentSegments(content)) {
    if (segment.type !== "event") {
      continue;
    }

    const current = referencesById.get(segment.eventId);

    if (!current) {
      referencesById.set(segment.eventId, {
        type: "event",
        identifier: segment.identifier,
        displayText: segment.text,
        eventId: segment.eventId,
        relayUrls: [...segment.relayUrls],
        authorPubkey: segment.authorPubkey,
      });
      continue;
    }

    current.relayUrls = [...new Set([...current.relayUrls, ...segment.relayUrls])];
    current.authorPubkey ??= segment.authorPubkey;
  }

  return [...referencesById.values()];
}

export function extractContentProfileReferences(content: string): ContentProfileReference[] {
  const referencesByPubkey = new Map<string, ContentProfileReference>();

  for (const segment of parseContentSegments(content)) {
    if (segment.type !== "mention") {
      continue;
    }

    const current = referencesByPubkey.get(segment.pubkey);

    if (!current) {
      referencesByPubkey.set(segment.pubkey, {
        type: "profile",
        identifier: segment.identifier,
        displayText: segment.text,
        pubkey: segment.pubkey,
        relayUrls: [...segment.relayUrls],
      });
      continue;
    }

    current.relayUrls = [...new Set([...current.relayUrls, ...segment.relayUrls])];
  }

  return [...referencesByPubkey.values()];
}
