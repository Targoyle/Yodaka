export const MAX_PROFILE_TEXT_LENGTH = 256;

export function sanitizeProfilePictureUrl(
  rawUrl: string | null | undefined,
  options?: { currentOrigin?: string },
) {
  if (!rawUrl) {
    return null;
  }

  const trimmed = rawUrl.trim();

  if (!trimmed) {
    return null;
  }

  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") {
    return null;
  }

  const currentOrigin =
    options?.currentOrigin ??
    (typeof window !== "undefined" ? window.location.origin : "");

  if (currentOrigin && parsed.origin === currentOrigin) {
    return null;
  }

  if (isDisallowedProfileImageHost(parsed.hostname)) {
    return null;
  }

  return parsed.toString();
}

export function sanitizeProfileText(
  value: unknown,
  options?: { maxLength?: number },
) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();

  if (!normalized) {
    return null;
  }

  const maxLength = options?.maxLength ?? MAX_PROFILE_TEXT_LENGTH;

  return normalized.slice(0, Math.max(1, maxLength));
}

function isDisallowedProfileImageHost(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    return true;
  }

  return isPrivateIpv4(normalized) || isPrivateIpv6(normalized);
}

function isPrivateIpv4(hostname: string) {
  const octets = hostname.split(".").map((value) => Number.parseInt(value, 10));

  if (
    octets.length !== 4 ||
    octets.some((value) => Number.isNaN(value) || value < 0 || value > 255)
  ) {
    return false;
  }

  const [first, second] = octets;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isPrivateIpv6(hostname: string) {
  if (hostname === "::" || hostname === "::1") {
    return true;
  }

  const mappedIpv4 = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);

  if (mappedIpv4) {
    return isPrivateIpv4(mappedIpv4[1]);
  }

  return /^(fc|fd|fe8|fe9|fea|feb)/i.test(hostname);
}
