import {
  useEffect,
  useMemo,
  useState,
  type MutableRefObject,
} from "react";
import type { TimelineView } from "../app/types";
import { normalizeRelayUrls, type RelayOneShotTransport } from "../lib/nostr/contacts";
import {
  buildEventLookupRelayUrls,
  fetchLatestEventByIdAcrossRelays,
  fetchLatestEventByIdViaAuthorRelays,
} from "../lib/nostr/eventDebug";
import {
  buildEmbeddedRepostTargetTimelineItem,
  buildStandaloneTimelineItem,
} from "../lib/nostr/timelineItem";
import { timelineItemsEqual } from "../lib/nostr/timelinePresentation";
import type { TimelineItem, TimelineProfile } from "../lib/wasm/client";

type ReplyPreviewCacheEntry =
  | {
      status: "hit";
      item: TimelineItem;
    }
  | {
      status: "pending";
    }
  | {
      status: "missing";
      retryAt: number;
    };

type UseReplyPreviewCacheArgs = {
  profileSummariesRef: MutableRefObject<Map<string, TimelineProfile>>;
  readRelayUrls: string[];
  referenceItems: TimelineItem[];
  timelineView: TimelineView;
  transport: RelayOneShotTransport;
  visibleTimeline: TimelineItem[];
};

export type ReplyPreviewLookupRequest = {
  authorPubkey: string | null;
  baseRelayUrls: string[];
  eventId: string;
  relayListLookupRelayUrls: string[];
};

type ReplyPreviewLookupCandidate = {
  authorPubkey: string | null;
  eventId: string;
  relayHintUrls: Set<string>;
};

export function useReplyPreviewCache(args: UseReplyPreviewCacheArgs) {
  const [replyPreviewCache, setReplyPreviewCache] = useState<
    Record<string, ReplyPreviewCacheEntry>
  >({});
  const [replyPreviewRetryClock, setReplyPreviewRetryClock] = useState(0);

  const replyPreviewItems = useMemo(
    () =>
      Object.values(replyPreviewCache).flatMap((entry) => (
        entry.status === "hit" ? [entry.item] : []
      )),
    [replyPreviewCache],
  );
  const replyPreviewStatuses = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(replyPreviewCache).map(([eventId, entry]) => [eventId, entry.status]),
      ) as Record<string, ReplyPreviewCacheEntry["status"]>,
    [replyPreviewCache],
  );
  const allReferenceItems = useMemo(
    () => [...args.referenceItems, ...replyPreviewItems],
    [args.referenceItems, replyPreviewItems],
  );

  useEffect(() => {
    const referenceById = new Map(allReferenceItems.map((item) => [item.id, item] as const));
    const resolvedPreviewEntries = args.visibleTimeline
      .flatMap((item) => (
        [item.replyTargetEventId, item.repostTargetEventId]
          .map((targetEventId) => {
            if (!targetEventId) {
              return null;
            }

            const targetItem = referenceById.get(targetEventId) ?? null;

            if (!targetItem || targetItem.id === item.id) {
              return null;
            }

            return {
              eventId: targetEventId,
              item: targetItem,
            };
          })
      ))
      .filter((entry): entry is { eventId: string; item: TimelineItem } => entry !== null);

    if (resolvedPreviewEntries.length === 0) {
      return;
    }

    setReplyPreviewCache((current) => {
      let changed = false;
      const next = { ...current };

      for (const entry of resolvedPreviewEntries) {
        const existingEntry = current[entry.eventId];

        if (
          existingEntry?.status === "hit"
          && timelineItemsEqual([existingEntry.item], [entry.item])
        ) {
          continue;
        }

        next[entry.eventId] = {
          status: "hit",
          item: entry.item,
        };
        changed = true;
      }

      return changed ? next : current;
    });
  }, [allReferenceItems, args.visibleTimeline]);

  useEffect(() => {
    const embeddedRepostPreviewEntries = args.visibleTimeline
      .map((item) => {
        const embeddedItem = buildEmbeddedRepostTargetTimelineItem(
          item,
          args.profileSummariesRef.current,
        );

        if (!embeddedItem) {
          return null;
        }

        return {
          eventId: embeddedItem.id,
          item: embeddedItem,
        };
      })
      .filter((entry): entry is { eventId: string; item: TimelineItem } => entry !== null);
    const embeddedRepostPreviewIds = new Set(
      embeddedRepostPreviewEntries.map((entry) => entry.eventId),
    );
    const referenceItemIds = new Set(allReferenceItems.map((item) => item.id));
    const now = Date.now();
    const lookupRequests = buildReplyPreviewLookupRequests({
      embeddedResolvedEventIds: embeddedRepostPreviewIds,
      now,
      readRelayUrls: args.readRelayUrls,
      referenceItemIds,
      replyPreviewCache,
      visibleTimeline: args.visibleTimeline,
    });
    const missingReplyTargetIds = lookupRequests.map((request) => request.eventId);

    if (
      embeddedRepostPreviewEntries.length === 0
      && missingReplyTargetIds.length === 0
    ) {
      return;
    }

    setReplyPreviewCache((current) => {
      let changed = false;
      const next = { ...current };

      for (const entry of embeddedRepostPreviewEntries) {
        const existingEntry = current[entry.eventId];

        if (
          existingEntry?.status === "hit"
          && timelineItemsEqual([existingEntry.item], [entry.item])
        ) {
          continue;
        }

        next[entry.eventId] = {
          status: "hit",
          item: entry.item,
        };
        changed = true;
      }

      for (const eventId of missingReplyTargetIds) {
        if (current[eventId]?.status === "pending") {
          continue;
        }

        next[eventId] = { status: "pending" };
        changed = true;
      }

      return changed ? next : current;
    });

    if (missingReplyTargetIds.length === 0) {
      return;
    }

    let cancelled = false;

    void (async () => {
      const settled = await Promise.allSettled(
        lookupRequests.map(async (request) => {
          return {
            eventId: request.eventId,
            event: args.timelineView === "relay" && request.authorPubkey === null
              ? await fetchLatestEventByIdAcrossRelays(
                request.baseRelayUrls,
                request.eventId,
                args.transport,
              )
              : await fetchLatestEventByIdViaAuthorRelays({
                authorPubkey: request.authorPubkey,
                baseRelayUrls: request.baseRelayUrls,
                eventId: request.eventId,
                relayListLookupRelayUrls: request.relayListLookupRelayUrls,
                transport: args.transport,
                options: { allowDirectFallback: true },
              }),
          };
        }),
      );

      if (cancelled) {
        return;
      }

      setReplyPreviewCache((current) => {
        let changed = false;
        const next = { ...current };
        const retryAt = Date.now() + 1_500;

        settled.forEach((entry, index) => {
          const eventId = lookupRequests[index]?.eventId;

          if (!eventId) {
            return;
          }

          if (entry.status === "rejected") {
            next[eventId] = {
              status: "missing",
              retryAt,
            };
            changed = true;
            return;
          }

          if (entry.value.event) {
            next[eventId] = {
              status: "hit",
              item: buildStandaloneTimelineItem(
                entry.value.event,
                args.profileSummariesRef.current.get(entry.value.event.pubkey) ?? null,
              ),
            };
          } else {
            next[eventId] = {
              status: "missing",
              retryAt,
            };
          }
          changed = true;
        });

        return changed ? next : current;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [
    allReferenceItems,
    args.profileSummariesRef,
    args.readRelayUrls,
    args.timelineView,
    args.transport,
    args.visibleTimeline,
    replyPreviewCache,
    replyPreviewRetryClock,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const referenceItemIds = new Set(allReferenceItems.map((item) => item.id));
    let nextRetryAt = Number.POSITIVE_INFINITY;

    for (const item of args.visibleTimeline) {
      const eventIds = [item.replyTargetEventId, item.repostTargetEventId];

      for (const eventId of eventIds) {
        if (!eventId || referenceItemIds.has(eventId)) {
          continue;
        }

        const entry = replyPreviewCache[eventId];

        if (entry?.status !== "missing") {
          continue;
        }

        nextRetryAt = Math.min(nextRetryAt, entry.retryAt);
      }
    }

    if (!Number.isFinite(nextRetryAt)) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setReplyPreviewRetryClock(Date.now());
    }, Math.max(0, nextRetryAt - Date.now()));

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [allReferenceItems, args.visibleTimeline, replyPreviewCache]);

  return {
    replyPreviewItems,
    replyPreviewStatuses,
  };
}

export function buildReplyPreviewLookupRequests(args: {
  embeddedResolvedEventIds: ReadonlySet<string>;
  now: number;
  readRelayUrls: string[];
  referenceItemIds: ReadonlySet<string>;
  replyPreviewCache: Readonly<Record<string, ReplyPreviewCacheEntry>>;
  visibleTimeline: TimelineItem[];
}) {
  const normalizedReadRelayUrls = normalizeRelayUrls(args.readRelayUrls);
  const candidates = new Map<string, ReplyPreviewLookupCandidate>();

  for (const item of args.visibleTimeline) {
    for (const target of collectReplyPreviewTargets(item)) {
      if (
        !target.eventId
        || args.referenceItemIds.has(target.eventId)
        || args.embeddedResolvedEventIds.has(target.eventId)
      ) {
        continue;
      }

      const candidate = candidates.get(target.eventId) ?? {
        authorPubkey: null,
        eventId: target.eventId,
        relayHintUrls: new Set<string>(),
      };

      if (!candidate.authorPubkey && target.authorPubkey) {
        candidate.authorPubkey = target.authorPubkey;
      }

      for (const relayUrl of normalizeRelayUrls(target.relayHintUrls)) {
        candidate.relayHintUrls.add(relayUrl);
      }

      candidates.set(target.eventId, candidate);
    }
  }

  return [...candidates.values()].flatMap((candidate) => {
    const cacheEntry = args.replyPreviewCache[candidate.eventId];

    if (cacheEntry?.status === "pending") {
      return [];
    }

    if (
      cacheEntry?.status === "missing"
      && cacheEntry.retryAt > args.now
    ) {
      return [];
    }

    const baseRelayUrls = buildEventLookupRelayUrls(
      normalizedReadRelayUrls,
      [...candidate.relayHintUrls],
    );

    if (baseRelayUrls.length === 0) {
      return [];
    }

    return [{
      authorPubkey: candidate.authorPubkey,
      baseRelayUrls,
      eventId: candidate.eventId,
      relayListLookupRelayUrls:
        normalizedReadRelayUrls.length > 0
          ? normalizedReadRelayUrls
          : baseRelayUrls,
    } satisfies ReplyPreviewLookupRequest];
  });
}

function collectReplyPreviewTargets(item: TimelineItem) {
  return [
    {
      authorPubkey: item.replyTargetPubkey,
      eventId: item.replyTargetEventId,
      relayHintUrls: item.replyTargetRelayHints ?? [],
    },
    {
      authorPubkey: item.repostTargetPubkey ?? null,
      eventId: item.repostTargetEventId ?? null,
      relayHintUrls: item.repostTargetRelayHints ?? [],
    },
  ];
}
