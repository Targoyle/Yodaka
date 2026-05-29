export type RelayAuthRequirement = "auth-required" | "restricted" | null;

export type ParsedRelayAuthMessage = {
  requirement: RelayAuthRequirement;
  detail: string | null;
  raw: string | null;
};

const AUTH_REQUIRED_PREFIX = "auth-required:";
const RESTRICTED_PREFIX = "restricted:";

export function parseRelayAuthMessage(message?: string | null): ParsedRelayAuthMessage {
  const raw = message?.trim() ?? null;

  if (!raw) {
    return {
      requirement: null,
      detail: null,
      raw: null,
    };
  }

  const normalized = raw.toLowerCase();

  if (normalized.startsWith(AUTH_REQUIRED_PREFIX)) {
    return {
      requirement: "auth-required",
      detail: raw.slice(AUTH_REQUIRED_PREFIX.length).trim() || null,
      raw,
    };
  }

  if (normalized.startsWith(RESTRICTED_PREFIX)) {
    return {
      requirement: "restricted",
      detail: raw.slice(RESTRICTED_PREFIX.length).trim() || null,
      raw,
    };
  }

  return {
    requirement: null,
    detail: raw,
    raw,
  };
}

export function formatRelayAccessMessage(message?: string | null) {
  const parsed = parseRelayAuthMessage(message);

  switch (parsed.requirement) {
    case "auth-required":
      return parsed.detail
        ? `relay が認証を要求しています: ${parsed.detail}`
        : "relay が認証を要求しています";

    case "restricted":
      return parsed.detail
        ? `relay がこの鍵を制限しています: ${parsed.detail}`
        : "relay がこの鍵を制限しています";

    default:
      return parsed.raw;
  }
}

export function formatRelayAccessLabel(
  message: string | null | undefined,
  fallbackLabel: string,
) {
  const parsed = parseRelayAuthMessage(message);

  switch (parsed.requirement) {
    case "auth-required":
      return `${fallbackLabel} 認証要求`;

    case "restricted":
      return `${fallbackLabel} 制限`;

    default:
      return fallbackLabel;
  }
}
