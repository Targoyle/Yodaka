import { normalizeHexPubkey } from "./pubkey";
import {
  matchesRelayFilter,
  parseRelayMessage,
  type NostrEvent,
  type RelayFilter,
} from "./relay";

const MAX_REPLACEABLE_EVENT_CONTENT_BYTES = 64 * 1024;
const MAX_REPLACEABLE_EVENT_TAGS = 4_096;
const MAX_REPLACEABLE_TAG_FIELDS = 8;
const MAX_REPLACEABLE_TAG_VALUE_BYTES = 2 * 1024;

export function requestDirectLatestReplaceableEvent(
  relayUrl: string,
  filter: RelayFilter,
  timeoutMs: number,
  errorMessages: {
    timeout: string;
    failed: string;
    disconnected: string;
  },
) {
  return new Promise<NostrEvent | null>((resolve, reject) => {
    const subscriptionId = createSubscriptionId();
    const socket = new WebSocket(relayUrl);
    let settled = false;
    let latestEvent: NostrEvent | null = null;

    const timeoutId = setTimeout(() => {
      finish(() => {
        reject(new Error(errorMessages.timeout));
      });
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeoutId);

      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(["CLOSE", subscriptionId]));
      }

      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    }

    function finish(callback: () => void) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      callback();
    }

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify(["REQ", subscriptionId, filter]));
    });

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }

      const message = parseReplaceableRelayMessage(event.data);

      if (!message) {
        return;
      }

      if (
        message.type === "EVENT"
        && message.subscriptionId === subscriptionId
        && matchesRelayFilter(message.event, filter)
      ) {
        if (!latestEvent || message.event.created_at >= latestEvent.created_at) {
          latestEvent = message.event;
        }
        return;
      }

      if (
        (message.type === "EOSE" || message.type === "CLOSED")
        && message.subscriptionId === subscriptionId
      ) {
        finish(() => {
          resolve(latestEvent);
        });
      }
    });

    socket.addEventListener("error", () => {
      finish(() => {
        reject(new Error(errorMessages.failed));
      });
    });

    socket.addEventListener("close", () => {
      if (settled) {
        return;
      }

      finish(() => {
        reject(new Error(errorMessages.disconnected));
      });
    });
  });
}

export function requestDirectEvents(
  relayUrl: string,
  filter: RelayFilter,
  timeoutMs: number,
  errorMessages: {
    timeout: string;
    failed: string;
    disconnected: string;
  },
) {
  return new Promise<NostrEvent[]>((resolve, reject) => {
    const subscriptionId = createSubscriptionId();
    const socket = new WebSocket(relayUrl);
    const events = new Map<string, NostrEvent>();
    let settled = false;

    const timeoutId = setTimeout(() => {
      finish(() => {
        reject(new Error(errorMessages.timeout));
      });
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeoutId);

      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(["CLOSE", subscriptionId]));
      }

      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    }

    function finish(callback: () => void) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      callback();
    }

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify(["REQ", subscriptionId, filter]));
    });

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }

      const message = parseRelayMessage(event.data);

      if (!message) {
        return;
      }

      if (
        message.type === "EVENT"
        && message.subscriptionId === subscriptionId
        && matchesRelayFilter(message.event, filter)
      ) {
        events.set(message.event.id, message.event);
        return;
      }

      if (
        (message.type === "EOSE" || message.type === "CLOSED")
        && message.subscriptionId === subscriptionId
      ) {
        finish(() => {
          resolve(
            [...events.values()]
              .sort((left, right) => right.created_at - left.created_at)
              .slice(0, filter.limit),
          );
        });
      }
    });

    socket.addEventListener("error", () => {
      finish(() => {
        reject(new Error(errorMessages.failed));
      });
    });

    socket.addEventListener("close", () => {
      if (settled) {
        return;
      }

      finish(() => {
        reject(new Error(errorMessages.disconnected));
      });
    });
  });
}

function parseReplaceableRelayMessage(data: string) {
  try {
    const parsed = JSON.parse(data);

    if (!Array.isArray(parsed) || parsed.length === 0) {
      return null;
    }

    const [kind, first, second] = parsed;

    if (kind === "EVENT" && typeof first === "string") {
      const event = parseReplaceableEvent(second);

      if (!event) {
        return null;
      }

      return {
        type: "EVENT" as const,
        subscriptionId: first,
        event,
      };
    }

    if (kind === "EOSE" && typeof first === "string") {
      return {
        type: "EOSE" as const,
        subscriptionId: first,
      };
    }

    if (kind === "CLOSED" && typeof first === "string") {
      return {
        type: "CLOSED" as const,
        subscriptionId: first,
      };
    }

    return null;
  } catch {
    return null;
  }
}

function parseReplaceableEvent(value: unknown): NostrEvent | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = value.id;
  const pubkey = value.pubkey;
  const createdAt = value.created_at;
  const kind = value.kind;
  const tags = value.tags;
  const content = value.content;
  const sig = value.sig;

  if (
    typeof id !== "string"
    || typeof pubkey !== "string"
    || typeof createdAt !== "number"
    || !Number.isInteger(createdAt)
    || createdAt < 0
    || typeof kind !== "number"
    || !Number.isInteger(kind)
    || kind < 0
    || typeof content !== "string"
    || typeof sig !== "string"
    || !Array.isArray(tags)
  ) {
    return null;
  }

  if (utf8ByteLength(content) > MAX_REPLACEABLE_EVENT_CONTENT_BYTES) {
    return null;
  }

  if (tags.length > MAX_REPLACEABLE_EVENT_TAGS) {
    return null;
  }

  const normalizedTags: string[][] = [];

  for (const tag of tags) {
    if (!Array.isArray(tag) || tag.length > MAX_REPLACEABLE_TAG_FIELDS) {
      return null;
    }

    const normalizedTag: string[] = [];

    for (const item of tag) {
      if (typeof item !== "string" || utf8ByteLength(item) > MAX_REPLACEABLE_TAG_VALUE_BYTES) {
        return null;
      }

      normalizedTag.push(item);
    }

    normalizedTags.push(normalizedTag);
  }

  return {
    id,
    pubkey: normalizeHexPubkey(pubkey),
    created_at: createdAt,
    kind,
    tags: normalizedTags,
    content,
    sig,
  };
}

function createSubscriptionId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `contacts-${crypto.randomUUID()}`;
  }

  return `contacts-${Math.random().toString(16).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function utf8ByteLength(value: string) {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value).length;
  }

  return new Blob([value]).size;
}
