import { parseRelayMessage, matchesRelayFilter, type NostrEvent } from "./relay";
import { normalizeHexPubkey } from "./pubkey";
import {
  normalizeRelayUrl,
  normalizeRelayUrls,
} from "./relayUrl";

export { normalizeRelayUrls } from "./relayUrl";

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_REPLACEABLE_EVENT_CONTENT_BYTES = 64 * 1024;
const MAX_REPLACEABLE_EVENT_TAGS = 4_096;
const MAX_REPLACEABLE_TAG_FIELDS = 8;
const MAX_REPLACEABLE_TAG_VALUE_BYTES = 2 * 1024;

export type FollowTarget = {
  pubkey: string;
  relayHints: string[];
};

export type RelayOneShotTransport = {
  requestTemporaryLatestEvent?: (
    relayUrl: string,
    filters: {
      kinds: number[];
      authors: string[];
      limit?: number;
    }[],
    timeoutMs?: number,
  ) => Promise<NostrEvent | null>;
  requestTemporaryEvents?: (
    relayUrl: string,
    filters: {
      kinds: number[];
      authors: string[];
      limit?: number;
    }[],
    timeoutMs?: number,
  ) => Promise<NostrEvent[]>;
};

export async function fetchFollowTargets(
  relayUrls: string[],
  pubkey: string,
  transport?: RelayOneShotTransport | null,
) {
  const normalizedPubkey = normalizeHexPubkey(pubkey);
  const normalizedRelays = normalizeRelayUrls(relayUrls);

  if (normalizedRelays.length === 0 || !normalizedPubkey) {
    return [];
  }

  const settled = await Promise.allSettled(
    normalizedRelays.map((relayUrl) =>
      requestReplaceableEvent(relayUrl, {
        kinds: [3],
        authors: [normalizedPubkey],
        limit: 1,
      }, transport),
    ),
  );

  let latestEvent: NostrEvent | null = null;
  let fulfilledCount = 0;

  for (const result of settled) {
    if (result.status !== "fulfilled") {
      continue;
    }

    fulfilledCount += 1;

    if (!result.value) {
      continue;
    }

    if (!latestEvent || result.value.created_at > latestEvent.created_at) {
      latestEvent = result.value;
    }
  }

  logFollowProbe({
    mode: "kind3",
    pubkey: normalizedPubkey,
    relays: normalizedRelays,
    settled,
    latestEvent,
  });

  if (!latestEvent) {
    if (fulfilledCount === 0) {
      throw new Error("follow 一覧の取得に失敗しました");
    }

    return [];
  }

  return extractFollowTargets(latestEvent.tags);
}

export async function fetchRecentNotesForFollowTargets(
  baseRelayUrls: string[],
  targets: FollowTarget[],
  limit: number,
  transport?: RelayOneShotTransport | null,
) {
  const relayAuthors = buildRelayAuthorMap(baseRelayUrls, targets);
  const settled = await Promise.allSettled(
    [...relayAuthors.entries()].map(([relayUrl, authors]) =>
      requestEvents(relayUrl, {
        kinds: [1],
        authors: [...authors],
        limit,
      }, transport),
    ),
  );

  logFollowProbe({
    mode: "notes",
    relayAuthorMap: relayAuthors,
    settled,
  });

  return mergeAndLimitEvents(settled, limit);
}

export async function fetchRecentNotesByAuthors(
  relayUrls: string[],
  authors: string[],
  limit: number,
  transport?: RelayOneShotTransport | null,
) {
  const normalizedAuthors = [
    ...new Set(
      authors
        .map((author) => normalizeHexPubkey(author))
        .filter(Boolean),
    ),
  ];
  const normalizedRelays = normalizeRelayUrls(relayUrls);

  if (normalizedAuthors.length === 0 || normalizedRelays.length === 0) {
    return [];
  }

  const settled = await Promise.allSettled(
    normalizedRelays.map((relayUrl) =>
      requestEvents(relayUrl, {
        kinds: [1],
        authors: normalizedAuthors,
        limit,
      }, transport),
    ),
  );

  return mergeAndLimitEvents(settled, limit);
}

export function extractFollowTargets(tags: string[][]) {
  const targets = new Map<string, Set<string>>();

  for (const tag of tags) {
    if (tag[0] !== "p") {
      continue;
    }

    const pubkey = normalizeHexPubkey(tag[1] ?? "");

    if (!pubkey) {
      continue;
    }

    const relayHints = targets.get(pubkey) ?? new Set<string>();
    const relayHint = normalizeRelayUrl(tag[2]);

    if (relayHint) {
      relayHints.add(relayHint);
    }

    targets.set(pubkey, relayHints);
  }

  return [...targets.entries()].map(([pubkey, relayHints]) => ({
    pubkey,
    relayHints: [...relayHints],
  }));
}

export function buildRelayAuthorMap(baseRelayUrls: string[], targets: FollowTarget[]) {
  const relayAuthors = new Map<string, Set<string>>();

  for (const relayUrl of normalizeRelayUrls(baseRelayUrls)) {
    for (const target of targets) {
      addAuthor(relayAuthors, relayUrl, target.pubkey);
    }
  }

  for (const target of targets) {
    for (const relayHint of target.relayHints) {
      addAuthor(relayAuthors, relayHint, target.pubkey);
    }
  }

  return relayAuthors;
}

function addAuthor(
  relayAuthors: Map<string, Set<string>>,
  relayUrl: string,
  pubkey: string,
) {
  const authors = relayAuthors.get(relayUrl) ?? new Set<string>();
  authors.add(normalizeHexPubkey(pubkey));
  relayAuthors.set(relayUrl, authors);
}

function mergeAndLimitEvents(
  settled: PromiseSettledResult<NostrEvent[]>[],
  limit: number,
) {
  const fulfilled = settled.filter(
    (result): result is PromiseFulfilledResult<NostrEvent[]> =>
      result.status === "fulfilled",
  );

  if (settled.length > 0 && fulfilled.length === 0) {
    const firstRejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    const firstMessage =
      firstRejected?.reason instanceof Error
        ? firstRejected.reason.message
        : firstRejected?.reason
          ? String(firstRejected.reason)
          : null;

    throw new Error(
      firstMessage
        ? `relay から投稿を取得できませんでした: ${firstMessage}`
        : "relay から投稿を取得できませんでした",
    );
  }

  const merged = new Map<string, NostrEvent>();

  for (const result of fulfilled) {
    for (const event of result.value) {
      merged.set(event.id, event);
    }
  }

  return [...merged.values()]
    .sort((left, right) => right.created_at - left.created_at)
    .slice(0, limit);
}

function requestReplaceableEvent(
  relayUrl: string,
  filter: {
    kinds: number[];
    authors: string[];
    limit: number;
  },
  transport?: RelayOneShotTransport | null,
) {
  return requestThroughTransport({
    relayUrl,
    transportRequest: transport?.requestTemporaryLatestEvent
      ? (targetRelayUrl, filters, timeoutMs) =>
        transport.requestTemporaryLatestEvent!(
          targetRelayUrl,
          filters,
          timeoutMs,
        )
      : undefined,
    filters: [filter],
    timeoutMs: REQUEST_TIMEOUT_MS,
    fallback: () =>
      new Promise<NostrEvent | null>((resolve, reject) => {
        const subscriptionId = createSubscriptionId();
        const socket = new WebSocket(relayUrl);
        let settled = false;
        let latestEvent: NostrEvent | null = null;

        const timeoutId = setTimeout(() => {
          finish(() => {
            reject(new Error("follow 一覧の取得がタイムアウトしました"));
          });
        }, REQUEST_TIMEOUT_MS);

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
            message.type === "EVENT" &&
            message.subscriptionId === subscriptionId &&
            matchesRelayFilter(message.event, filter)
          ) {
            if (!latestEvent || message.event.created_at >= latestEvent.created_at) {
              latestEvent = message.event;
            }
            return;
          }

          if (
            (message.type === "EOSE" || message.type === "CLOSED") &&
            message.subscriptionId === subscriptionId
          ) {
            finish(() => {
              resolve(latestEvent);
            });
          }
        });

        socket.addEventListener("error", () => {
          finish(() => {
            reject(new Error("follow 一覧の取得に失敗しました"));
          });
        });

        socket.addEventListener("close", () => {
          if (settled) {
            return;
          }

          finish(() => {
            reject(new Error("follow 一覧の取得中に relay から切断されました"));
          });
        });
      }),
    normalizeTransportError: (error) =>
      normalizeTransportErrorMessage(error, {
        timeout: "follow 一覧の取得がタイムアウトしました",
        failed: "follow 一覧の取得に失敗しました",
      }),
  });
}

function requestEvents(
  relayUrl: string,
  filter: {
    kinds: number[];
    authors: string[];
    limit: number;
  },
  transport?: RelayOneShotTransport | null,
) {
  return requestThroughTransport({
    relayUrl,
    transportRequest: transport?.requestTemporaryEvents
      ? (targetRelayUrl, filters, timeoutMs) =>
        transport.requestTemporaryEvents!(
          targetRelayUrl,
          filters,
          timeoutMs,
        )
      : undefined,
    filters: [filter],
    timeoutMs: REQUEST_TIMEOUT_MS,
    fallback: () =>
      new Promise<NostrEvent[]>((resolve, reject) => {
        const subscriptionId = createSubscriptionId();
        const socket = new WebSocket(relayUrl);
        const events = new Map<string, NostrEvent>();
        let settled = false;

        const timeoutId = setTimeout(() => {
          finish(() => {
            reject(new Error("投稿取得がタイムアウトしました"));
          });
        }, REQUEST_TIMEOUT_MS);

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
            message.type === "EVENT" &&
            message.subscriptionId === subscriptionId &&
            matchesRelayFilter(message.event, filter)
          ) {
            events.set(message.event.id, message.event);
            return;
          }

          if (
            (message.type === "EOSE" || message.type === "CLOSED") &&
            message.subscriptionId === subscriptionId
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
            reject(new Error("投稿取得に失敗しました"));
          });
        });

        socket.addEventListener("close", () => {
          if (settled) {
            return;
          }

          finish(() => {
            reject(new Error("投稿取得中に relay から切断されました"));
          });
        });
      }),
    normalizeTransportError: (error) =>
      normalizeTransportErrorMessage(error, {
        timeout: "投稿取得がタイムアウトしました",
        failed: "投稿取得に失敗しました",
      }),
  });
}

async function requestThroughTransport<T>(args: {
  relayUrl: string;
  transportRequest?:
    | ((
        relayUrl: string,
        filters: {
          kinds: number[];
          authors: string[];
          limit?: number;
        }[],
        timeoutMs?: number,
      ) => Promise<T>)
    | null;
  filters: {
    kinds: number[];
    authors: string[];
    limit?: number;
  }[];
  timeoutMs: number;
  fallback: () => Promise<T>;
  normalizeTransportError: (error: unknown) => Error;
}) {
  if (!args.transportRequest) {
    return args.fallback();
  }

  try {
    return await args.transportRequest(args.relayUrl, args.filters, args.timeoutMs);
  } catch (error) {
    if (isTransportUnavailableError(error)) {
      return args.fallback();
    }

    throw args.normalizeTransportError(error);
  }
}

function isTransportUnavailableError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message === "relay is not connected"
    || error.message === "relay client が初期化されていません"
  );
}

function normalizeTransportErrorMessage(
  error: unknown,
  messages: {
    timeout: string;
    failed: string;
  },
) {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("timed out")) {
    return new Error(messages.timeout);
  }

  return new Error(messages.failed);
}

function createSubscriptionId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `contacts-${crypto.randomUUID()}`;
  }

  return `contacts-${Math.random().toString(16).slice(2)}`;
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
    typeof id !== "string" ||
    typeof pubkey !== "string" ||
    typeof createdAt !== "number" ||
    !Number.isInteger(createdAt) ||
    createdAt < 0 ||
    typeof kind !== "number" ||
    !Number.isInteger(kind) ||
    kind < 0 ||
    typeof content !== "string" ||
    typeof sig !== "string" ||
    !Array.isArray(tags)
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
      if (
        typeof item !== "string" ||
        utf8ByteLength(item) > MAX_REPLACEABLE_TAG_VALUE_BYTES
      ) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function utf8ByteLength(value: string) {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value).length;
  }

  return unescape(encodeURIComponent(value)).length;
}

function logFollowProbe(args: {
  mode: "kind3";
  pubkey: string;
  relays: string[];
  settled: PromiseSettledResult<NostrEvent | null>[];
  latestEvent: NostrEvent | null;
} | {
  mode: "notes";
  relayAuthorMap: Map<string, Set<string>>;
  settled: PromiseSettledResult<NostrEvent[]>[];
}) {
  if (!import.meta.env.DEV || import.meta.env.MODE === "test") {
    return;
  }

  if (args.mode === "kind3") {
    const results = args.relays.map((relayUrl, index) => {
      const result = args.settled[index];

      if (!result) {
        return {
          relayUrl,
          status: "missing_result",
        };
      }

      if (result.status === "rejected") {
        return {
          relayUrl,
          status: "rejected",
          reason:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        };
      }

      return {
        relayUrl,
        status: result.value ? "found" : "missing",
        createdAt: result.value?.created_at ?? null,
      };
    });

    console.info("[follow:kind3_probe]", {
      pubkey: args.pubkey,
      latestCreatedAt: args.latestEvent?.created_at ?? null,
      latestEventId: args.latestEvent?.id ?? null,
      results,
    });
    return;
  }

  const results = [...args.relayAuthorMap.entries()].map(([relayUrl, authors], index) => {
    const result = args.settled[index];

    if (!result) {
      return {
        relayUrl,
        authorCount: authors.size,
        status: "missing_result",
      };
    }

    if (result.status === "rejected") {
      return {
        relayUrl,
        authorCount: authors.size,
        status: "rejected",
        reason:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      };
    }

    return {
      relayUrl,
      authorCount: authors.size,
      status: "fulfilled",
      noteCount: result.value.length,
    };
  });

  console.info("[follow:notes_probe]", {
    relayCount: args.relayAuthorMap.size,
    results,
  });
}
