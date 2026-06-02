import {
  useEffect,
  useMemo,
  useState,
  type MutableRefObject,
} from "react";
import type { TimelineView } from "../app/types";
import type { RelayOneShotTransport } from "../lib/nostr/contacts";
import {
  fetchLatestEventByIdAcrossRelays,
  fetchLatestEventByIdViaAuthorRelays,
} from "../lib/nostr/eventDebug";
import { buildStandaloneTimelineItem } from "../lib/nostr/timelineItem";
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
  readyReadRelayCount: number;
  referenceItems: TimelineItem[];
  timelineView: TimelineView;
  transport: RelayOneShotTransport;
  visibleTimeline: TimelineItem[];
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
      .map((item) => {
        const targetEventId = item.replyTargetEventId;

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
    if (args.readyReadRelayCount <= 0 || args.readRelayUrls.length === 0) {
      return;
    }

    const referenceItemIds = new Set(allReferenceItems.map((item) => item.id));
    const now = Date.now();
    const missingReplyTargetIds = [...new Set(
      args.visibleTimeline
        .map((item) => item.replyTargetEventId)
        .filter((eventId): eventId is string => (
          typeof eventId === "string"
          && eventId.length > 0
          && !referenceItemIds.has(eventId)
          && (
            !replyPreviewCache[eventId]
            || (
              replyPreviewCache[eventId]?.status === "missing"
              && replyPreviewCache[eventId].retryAt <= now
            )
          )
        )),
    )];

    if (missingReplyTargetIds.length === 0) {
      return;
    }

    setReplyPreviewCache((current) => {
      let changed = false;
      const next = { ...current };

      for (const eventId of missingReplyTargetIds) {
        if (current[eventId]?.status === "pending") {
          continue;
        }

        next[eventId] = { status: "pending" };
        changed = true;
      }

      return changed ? next : current;
    });

    let cancelled = false;

    void (async () => {
      const settled = await Promise.allSettled(
        missingReplyTargetIds.map(async (eventId) => {
          const sourceItem = args.visibleTimeline.find(
            (item) => item.replyTargetEventId === eventId,
          );
          const isRelayTimeline = args.timelineView === "relay";

          return {
            eventId,
            event: isRelayTimeline
              ? await fetchLatestEventByIdAcrossRelays(
                args.readRelayUrls,
                eventId,
                args.transport,
              )
              : await fetchLatestEventByIdViaAuthorRelays({
                authorPubkey: sourceItem?.replyTargetPubkey,
                baseRelayUrls: [
                  ...args.readRelayUrls,
                  ...(sourceItem?.replyTargetRelayHints ?? []),
                ],
                eventId,
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
          const eventId = missingReplyTargetIds[index];

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
    args.readyReadRelayCount,
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
      const eventId = item.replyTargetEventId;

      if (!eventId || referenceItemIds.has(eventId)) {
        continue;
      }

      const entry = replyPreviewCache[eventId];

      if (entry?.status !== "missing") {
        continue;
      }

      nextRetryAt = Math.min(nextRetryAt, entry.retryAt);
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
