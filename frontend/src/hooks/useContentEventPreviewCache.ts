import {
  useEffect,
  useMemo,
  useState,
  type MutableRefObject,
} from "react";
import { normalizeRelayUrls, type RelayOneShotTransport } from "../lib/nostr/contacts";
import {
  extractContentEventReferences,
  type ContentEventReference,
} from "../lib/nostr/contentReferences";
import { fetchLatestEventByIdViaAuthorRelays } from "../lib/nostr/eventDebug";
import { buildStandaloneTimelineItem } from "../lib/nostr/timelineItem";
import { timelineItemsEqual } from "../lib/nostr/timelinePresentation";
import type { TimelineItem, TimelineProfile } from "../lib/wasm/client";

type ContentEventPreviewCacheEntry =
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

type UseContentEventPreviewCacheArgs = {
  profileSummariesRef: MutableRefObject<Map<string, TimelineProfile>>;
  readRelayUrls: string[];
  referenceItems: TimelineItem[];
  transport: RelayOneShotTransport;
  visibleTimeline: TimelineItem[];
};

type PendingContentEventReference = ContentEventReference & {
  baseRelayUrls: string[];
};

export function useContentEventPreviewCache(args: UseContentEventPreviewCacheArgs) {
  const [contentEventPreviewCache, setContentEventPreviewCache] = useState<
    Record<string, ContentEventPreviewCacheEntry>
  >({});
  const [contentEventPreviewRetryClock, setContentEventPreviewRetryClock] = useState(0);

  const contentEventPreviewItems = useMemo(
    () =>
      Object.values(contentEventPreviewCache).flatMap((entry) => (
        entry.status === "hit" ? [entry.item] : []
      )),
    [contentEventPreviewCache],
  );
  const allReferenceItems = useMemo(
    () => [...args.referenceItems, ...contentEventPreviewItems],
    [args.referenceItems, contentEventPreviewItems],
  );
  const visibleContentEventReferences = useMemo(
    () => collectVisibleContentEventReferences(args.visibleTimeline),
    [args.visibleTimeline],
  );

  useEffect(() => {
    const referenceById = new Map(allReferenceItems.map((item) => [item.id, item] as const));
    const resolvedPreviewEntries = visibleContentEventReferences
      .map((reference) => {
        const targetItem = referenceById.get(reference.eventId) ?? null;

        if (!targetItem) {
          return null;
        }

        return {
          eventId: reference.eventId,
          item: targetItem,
        };
      })
      .filter((entry): entry is { eventId: string; item: TimelineItem } => entry !== null);

    if (resolvedPreviewEntries.length === 0) {
      return;
    }

    setContentEventPreviewCache((current) => {
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
  }, [allReferenceItems, visibleContentEventReferences]);

  useEffect(() => {
    const referenceItemIds = new Set(allReferenceItems.map((item) => item.id));
    const now = Date.now();
    const missingReferences = visibleContentEventReferences
      .map((reference) => {
        const baseRelayUrls = normalizeRelayUrls([
          ...args.readRelayUrls,
          ...reference.relayUrls,
        ]);

        return {
          ...reference,
          baseRelayUrls,
        };
      })
      .filter((reference): reference is PendingContentEventReference => {
        const cacheEntry = contentEventPreviewCache[reference.eventId];

        if (referenceItemIds.has(reference.eventId) || reference.baseRelayUrls.length === 0) {
          return false;
        }

        return (
          !cacheEntry
          || (cacheEntry.status === "missing" && cacheEntry.retryAt <= now)
        );
      });

    if (missingReferences.length === 0) {
      return;
    }

    setContentEventPreviewCache((current) => {
      let changed = false;
      const next = { ...current };

      for (const reference of missingReferences) {
        if (current[reference.eventId]?.status === "pending") {
          continue;
        }

        next[reference.eventId] = { status: "pending" };
        changed = true;
      }

      return changed ? next : current;
    });

    let cancelled = false;

    void (async () => {
      const settled = await Promise.allSettled(
        missingReferences.map(async (reference) => ({
          eventId: reference.eventId,
          event: await fetchLatestEventByIdViaAuthorRelays({
            authorPubkey: reference.authorPubkey,
            baseRelayUrls: reference.baseRelayUrls,
            eventId: reference.eventId,
            transport: args.transport,
            options: { allowDirectFallback: true },
          }),
        })),
      );

      if (cancelled) {
        return;
      }

      setContentEventPreviewCache((current) => {
        let changed = false;
        const next = { ...current };
        const retryAt = Date.now() + 1_500;

        settled.forEach((entry, index) => {
          const reference = missingReferences[index];

          if (!reference) {
            return;
          }

          if (entry.status === "rejected") {
            next[reference.eventId] = {
              status: "missing",
              retryAt,
            };
            changed = true;
            return;
          }

          if (entry.value.event) {
            next[reference.eventId] = {
              status: "hit",
              item: buildStandaloneTimelineItem(
                entry.value.event,
                args.profileSummariesRef.current.get(entry.value.event.pubkey) ?? null,
              ),
            };
          } else {
            next[reference.eventId] = {
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
    args.transport,
    contentEventPreviewCache,
    contentEventPreviewRetryClock,
    visibleContentEventReferences,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const referenceItemIds = new Set(allReferenceItems.map((item) => item.id));
    let nextRetryAt = Number.POSITIVE_INFINITY;

    for (const reference of visibleContentEventReferences) {
      if (referenceItemIds.has(reference.eventId)) {
        continue;
      }

      const entry = contentEventPreviewCache[reference.eventId];

      if (entry?.status !== "missing") {
        continue;
      }

      nextRetryAt = Math.min(nextRetryAt, entry.retryAt);
    }

    if (!Number.isFinite(nextRetryAt)) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setContentEventPreviewRetryClock(Date.now());
    }, Math.max(0, nextRetryAt - Date.now()));

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [allReferenceItems, contentEventPreviewCache, visibleContentEventReferences]);

  return {
    contentEventPreviewItems,
  };
}

function collectVisibleContentEventReferences(visibleTimeline: TimelineItem[]) {
  const referencesById = new Map<string, ContentEventReference>();

  for (const item of visibleTimeline) {
    for (const reference of extractContentEventReferences(item.content)) {
      if (reference.eventId === item.id) {
        continue;
      }

      const current = referencesById.get(reference.eventId);

      if (!current) {
        referencesById.set(reference.eventId, {
          type: "event",
          identifier: reference.identifier,
          displayText: reference.displayText,
          eventId: reference.eventId,
          relayUrls: [...reference.relayUrls],
          authorPubkey: reference.authorPubkey,
        });
        continue;
      }

      current.relayUrls = [...new Set([...current.relayUrls, ...reference.relayUrls])];
      current.authorPubkey ??= reference.authorPubkey;
    }
  }

  return [...referencesById.values()];
}
