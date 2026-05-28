const HEX_PUBKEY_RE = /^[0-9a-fA-F]{64}$/;

export function normalizeHexPubkey(value: string) {
  const trimmed = value.trim();

  if (!HEX_PUBKEY_RE.test(trimmed)) {
    return trimmed;
  }

  return trimmed.toLowerCase();
}
