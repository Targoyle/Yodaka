import { decodeNpub } from "./nip19";
import { normalizeHexPubkey } from "./pubkey";

export function parseViewerPubkeyInput(value: string) {
  const trimmed = value.trim();

  if (trimmed === "") {
    return null;
  }

  const decodedNpub = decodeNpub(trimmed);

  if (decodedNpub) {
    return normalizeHexPubkey(decodedNpub);
  }

  const normalizedHex = normalizeHexPubkey(trimmed);

  if (/^[0-9a-f]{64}$/.test(normalizedHex)) {
    return normalizedHex;
  }

  return null;
}
