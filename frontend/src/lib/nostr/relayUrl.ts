const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function normalizeRelayUrls(relayUrls: string[]) {
  return [
    ...new Set(
      relayUrls
        .map((relayUrl) => normalizeRelayUrl(relayUrl))
        .filter((relayUrl): relayUrl is string => relayUrl !== null),
    ),
  ];
}

export function normalizeRelayUrl(relayUrl: string | undefined) {
  const trimmed = relayUrl?.trim();

  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);

    if (url.protocol === "wss:") {
      return url.toString();
    }

    if (url.protocol === "ws:" && isLocalDevelopmentRelay(url.hostname)) {
      return url.toString();
    }

    return null;
  } catch {
    return null;
  }
}

function isLocalDevelopmentRelay(hostname: string) {
  const normalized = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");

  return (
    LOCALHOST_HOSTS.has(normalized) || normalized.endsWith(".localhost")
  );
}
