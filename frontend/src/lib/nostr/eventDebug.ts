import type { TimelineItem } from "../wasm/client";
import type { RelayOneShotTransport } from "./contacts";
import { requestDirectEvents } from "./directRelayFallback";
import { normalizeRelayUrls } from "./contacts";
import type { NostrEvent } from "./relay";
import { normalizeHexPubkey } from "./pubkey";

const DEBUG_EVENT_REQUEST_TIMEOUT_MS = 8_000;
const DEBUG_RELAY_LIST_REQUEST_TIMEOUT_MS = 8_000;

export async function fetchLatestEventByIdAcrossRelays(
  relayUrls: string[],
  eventId: string,
  transport: RelayOneShotTransport,
  options?: {
    allowDirectFallback?: boolean;
  },
) {
  const normalizedRelays = normalizeRelayUrls(relayUrls);

  if (!eventId || normalizedRelays.length === 0 || !transport.requestTemporaryLatestEvent) {
    return null;
  }

  try {
    return await Promise.any(
      normalizedRelays.map(async (relayUrl) => {
        const event = await transport.requestTemporaryLatestEvent!(
          relayUrl,
          [{ ids: [eventId], limit: 1 }],
          DEBUG_EVENT_REQUEST_TIMEOUT_MS,
        );

        if (!event) {
          throw new Error("event not found");
        }

        return event;
      }),
    );
  } catch {
    // どの read relay でも見つからなかった場合だけ、従来の fallback へ進む
  }

  const settled = await Promise.allSettled(
    normalizedRelays.map((relayUrl) =>
      transport.requestTemporaryLatestEvent!(
        relayUrl,
        [{ ids: [eventId], limit: 1 }],
        DEBUG_EVENT_REQUEST_TIMEOUT_MS,
      ),
    ),
  );

  let latestEvent: NostrEvent | null = null;

  for (const result of settled) {
    if (result.status !== "fulfilled" || !result.value) {
      continue;
    }

    if (
      !latestEvent
      || result.value.created_at > latestEvent.created_at
      || (
        result.value.created_at === latestEvent.created_at
        && result.value.id > latestEvent.id
      )
    ) {
      latestEvent = result.value;
    }
  }

  if (latestEvent || !options?.allowDirectFallback) {
    return latestEvent;
  }

  const directSettled = await Promise.allSettled(
    normalizedRelays.map((relayUrl) =>
      requestDirectEvents(
        relayUrl,
        { ids: [eventId], limit: 1 },
        DEBUG_EVENT_REQUEST_TIMEOUT_MS,
        {
          timeout: "event id direct fetch timed out",
          failed: "event id direct fetch failed",
          disconnected: "event id direct fetch disconnected",
        },
      ),
    ),
  );

  for (const result of directSettled) {
    if (result.status !== "fulfilled" || result.value.length === 0) {
      continue;
    }

    const candidate = result.value[0];

    if (
      candidate
      && (
        !latestEvent
        || candidate.created_at > latestEvent.created_at
        || (
          candidate.created_at === latestEvent.created_at
          && candidate.id > latestEvent.id
        )
      )
    ) {
      latestEvent = candidate;
    }
  }

  return latestEvent;
}

export async function fetchLatestEventByIdViaAuthorRelays(args: {
  authorPubkey: string | null | undefined;
  baseRelayUrls: string[];
  eventId: string;
  transport: RelayOneShotTransport;
  options?: {
    allowDirectFallback?: boolean;
  };
}) {
  const directMatch = await fetchLatestEventByIdAcrossRelays(
    args.baseRelayUrls,
    args.eventId,
    args.transport,
    args.options,
  );

  if (directMatch) {
    return directMatch;
  }

  const authorPubkey = normalizeHexPubkey(args.authorPubkey ?? "");

  if (!authorPubkey) {
    return null;
  }

  const relayListUrls = await fetchReadRelayUrlsByPubkey(
    args.baseRelayUrls,
    authorPubkey,
    args.transport,
    args.options,
  );

  if (relayListUrls.length === 0) {
    return null;
  }

  const expandedRelayUrls = normalizeRelayUrls([
    ...args.baseRelayUrls,
    ...relayListUrls,
  ]);

  if (expandedRelayUrls.length === 0) {
    return null;
  }

  return fetchLatestEventByIdAcrossRelays(
    expandedRelayUrls,
    args.eventId,
    args.transport,
    args.options,
  );
}

export async function fetchReadRelayUrlsByPubkey(
  relayUrls: string[],
  pubkey: string,
  transport: RelayOneShotTransport,
  options?: {
    allowDirectFallback?: boolean;
  },
) {
  const normalizedPubkey = normalizeHexPubkey(pubkey);
  const normalizedRelays = normalizeRelayUrls(relayUrls);

  if (
    !normalizedPubkey
    || normalizedRelays.length === 0
    || !transport.requestTemporaryLatestEvent
  ) {
    return [];
  }

  const settled = await Promise.allSettled(
    normalizedRelays.map((relayUrl) =>
      transport.requestTemporaryLatestEvent!(
        relayUrl,
        [{ kinds: [10002], authors: [normalizedPubkey], limit: 1 }],
        DEBUG_RELAY_LIST_REQUEST_TIMEOUT_MS,
      ),
    ),
  );

  let latestEvent: NostrEvent | null = null;

  for (const result of settled) {
    if (result.status !== "fulfilled" || !result.value) {
      continue;
    }

    if (
      !latestEvent
      || result.value.created_at > latestEvent.created_at
      || (
        result.value.created_at === latestEvent.created_at
        && result.value.id > latestEvent.id
      )
    ) {
      latestEvent = result.value;
    }
  }

  if (!latestEvent && options?.allowDirectFallback) {
    const directSettled = await Promise.allSettled(
      normalizedRelays.map((relayUrl) =>
        requestDirectEvents(
          relayUrl,
          {
            kinds: [10002],
            authors: [normalizedPubkey],
            limit: 1,
          },
          DEBUG_RELAY_LIST_REQUEST_TIMEOUT_MS,
          {
            timeout: "relay list direct fetch timed out",
            failed: "relay list direct fetch failed",
            disconnected: "relay list direct fetch disconnected",
          },
        ),
      ),
    );

    for (const result of directSettled) {
      if (result.status !== "fulfilled" || result.value.length === 0) {
        continue;
      }

      const candidate = result.value[0];

      if (
        candidate
        && (
          !latestEvent
          || candidate.created_at > latestEvent.created_at
          || (
            candidate.created_at === latestEvent.created_at
            && candidate.id > latestEvent.id
          )
        )
      ) {
        latestEvent = candidate;
      }
    }
  }

  if (!latestEvent) {
    return [];
  }

  return extractReadRelayUrlsFromRelayListEvent(latestEvent);
}

export function extractReadRelayUrlsFromRelayListEvent(event: NostrEvent) {
  if (event.kind !== 10002) {
    return [];
  }

  const readRelayUrls = event.tags
    .filter((tag) => tag[0] === "r" && typeof tag[1] === "string")
    .filter((tag) => tag[2] !== "write")
    .map((tag) => tag[1] ?? "")
    .filter((relayUrl) => relayUrl.length > 0);

  return normalizeRelayUrls(readRelayUrls);
}

export function formatDebugEventJson(
  rawEvent: NostrEvent | null,
  fallbackItem: TimelineItem,
) {
  if (rawEvent) {
    return JSON.stringify(rawEvent, null, 2);
  }

  return JSON.stringify(
    {
      id: fallbackItem.id,
      pubkey: fallbackItem.pubkey,
      created_at: fallbackItem.createdAt,
      kind: fallbackItem.kind,
      content: fallbackItem.content,
      reply_target_event_id: fallbackItem.replyTargetEventId ?? null,
      reply_target_pubkey: fallbackItem.replyTargetPubkey,
      reply_target_relay_hints: fallbackItem.replyTargetRelayHints ?? [],
      reply_context_pubkeys: fallbackItem.replyContextPubkeys,
      like_count: fallbackItem.likeCount,
      kusa_count: fallbackItem.kusaCount ?? 0,
      more_reaction_count: fallbackItem.moreReactionCount ?? 0,
      other_reaction_summaries: fallbackItem.otherReactionSummaries ?? [],
      notify_actor_pubkey: fallbackItem.notifyActorPubkey ?? null,
      notify_reaction_content: fallbackItem.notifyReactionContent ?? null,
      notify_target_event_id: fallbackItem.notifyTargetEventId ?? null,
      notify_target_resolved: fallbackItem.notifyTargetResolved ?? false,
    },
    null,
    2,
  );
}
