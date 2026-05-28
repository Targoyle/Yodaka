import { normalizeHexPubkey } from "./pubkey";
import type { SignedNostrEvent, UnsignedNostrEvent } from "./signer";

export function assertSignedEventMatchesUnsigned(
  unsignedEvent: UnsignedNostrEvent,
  signedEvent: SignedNostrEvent,
) {
  if (!signedEvent.id.trim()) {
    throw new Error("署名済み event の id が空です");
  }

  if (!signedEvent.sig.trim()) {
    throw new Error("署名済み event の sig が空です");
  }

  if (normalizeHexPubkey(signedEvent.pubkey) !== normalizeHexPubkey(unsignedEvent.pubkey)) {
    throw new Error("署名済み event の pubkey が要求内容と一致しません");
  }

  if (signedEvent.created_at !== unsignedEvent.created_at) {
    throw new Error("署名済み event の created_at が要求内容と一致しません");
  }

  if (signedEvent.kind !== unsignedEvent.kind) {
    throw new Error("署名済み event の kind が要求内容と一致しません");
  }

  if (signedEvent.content !== unsignedEvent.content) {
    throw new Error("署名済み event の content が要求内容と一致しません");
  }

  if (!areTagsEqual(unsignedEvent.tags, signedEvent.tags)) {
    throw new Error("署名済み event の tags が要求内容と一致しません");
  }
}

function areTagsEqual(left: string[][], right: string[][]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((leftTag, index) => {
    const rightTag = right[index];

    if (!rightTag || leftTag.length !== rightTag.length) {
      return false;
    }

    return leftTag.every((value, valueIndex) => value === rightTag[valueIndex]);
  });
}
