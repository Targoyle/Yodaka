import { extractContentProfileReferences } from "./contentReferences";
import { normalizeHexPubkey } from "./pubkey";
import type { NostrEvent } from "./relay";

export function extractProfileLookupPubkeysFromEvent(event: NostrEvent) {
  const pubkeys = new Set<string>();

  pushPubkey(pubkeys, event.pubkey);

  for (const tag of event.tags) {
    if (tag[0] === "p") {
      pushPubkey(pubkeys, tag[1]);
      continue;
    }

    if (tag[0] === "e") {
      pushPubkey(pubkeys, tag[4]);
      continue;
    }

    if (tag[0] === "a") {
      pushPubkey(pubkeys, extractAddressPubkey(tag[1]));
    }
  }

  for (const reference of extractContentProfileReferences(event.content)) {
    pushPubkey(pubkeys, reference.pubkey);
  }

  return [...pubkeys];
}

function extractAddressPubkey(value: string | undefined) {
  if (!value) {
    return null;
  }

  const [, pubkey] = value.split(":");

  return pubkey ?? null;
}

function pushPubkey(pubkeys: Set<string>, value: string | null | undefined) {
  if (!value) {
    return;
  }

  const normalizedPubkey = normalizeHexPubkey(value);

  if (!/^[0-9a-f]{64}$/.test(normalizedPubkey)) {
    return;
  }

  pubkeys.add(normalizedPubkey);
}
