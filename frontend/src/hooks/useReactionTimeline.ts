import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type { AuxiliaryLoadState, TimelineView } from "../app/types";
import {
  fetchRecentReactionNotesByAuthors,
} from "../lib/nostr/contacts";
import type { NostrEvent } from "../lib/nostr/relay";
import type { RelayCoordinator } from "../lib/nostr/relayCoordinator";
import { loadAccountRelayUrls } from "../lib/nostr/relaySettings";
import { UnsupportedSignerError } from "../lib/nostr/signer";
import {
  buildAuxiliaryTimeline,
  mergeAuxiliaryTimeline,
  timelineItemsEqual,
} from "../lib/nostr/timelinePresentation";
import type { TimelineItem, TimelineProfile } from "../lib/wasm/client";

type UseReactionTimelineArgs = {
  autoSignerPromptBlocked: boolean;
  ensureViewerPubkey: (manualPubkey: string | null) => Promise<string>;
  ingestOverlayEvents: (events: NostrEvent[]) => Promise<TimelineItem[] | null>;
  isResolvingSignerPubkey: boolean;
  manualPubkey: string | null;
  markSignerUnavailable: () => void;
  profileSummariesRef: MutableRefObject<Map<string, TimelineProfile>>;
  readRelayUrls: string[];
  relayBootstrapDeferred: boolean;
  relayConfigurationKey: string;
  relayCoordinatorRef: MutableRefObject<RelayCoordinator | null>;
  readyReadRelayCount: number;
  signerAvailable: boolean;
  timeline: TimelineItem[];
  timelineLimit: number;
  timelineRef: MutableRefObject<TimelineItem[]>;
  timelineView: TimelineView;
  viewerPubkey: string | null;
};

export function useReactionTimeline(args: UseReactionTimelineArgs) {
  const [reactionLoadState, setReactionLoadState] = useState<AuxiliaryLoadState>("idle");
  const [reactionError, setReactionError] = useState<string | null>(null);
  const [reactionTimeline, setReactionTimeline] = useState<TimelineItem[]>([]);
  const [reactionTargetIds, setReactionTargetIds] = useState<string[]>([]);
  const [retryRevision, setRetryRevision] = useState(0);

  const accountRelayUrls = useMemo(
    () => loadAccountRelayUrls(args.readRelayUrls),
    [args.relayConfigurationKey],
  );
  const ensureViewerPubkeyRef = useRef(args.ensureViewerPubkey);
  const ingestOverlayEventsRef = useRef(args.ingestOverlayEvents);
  const markSignerUnavailableRef = useRef(args.markSignerUnavailable);
  const localReactionTargetIdsRef = useRef<string[]>([]);
  const reactionSourceKeyRef = useRef<string | null>(null);

  useEffect(() => {
    ensureViewerPubkeyRef.current = args.ensureViewerPubkey;
  }, [args.ensureViewerPubkey]);

  useEffect(() => {
    ingestOverlayEventsRef.current = args.ingestOverlayEvents;
  }, [args.ingestOverlayEvents]);

  useEffect(() => {
    markSignerUnavailableRef.current = args.markSignerUnavailable;
  }, [args.markSignerUnavailable]);

  useEffect(() => {
    if (args.relayBootstrapDeferred) {
      return;
    }

    if (args.timelineView !== "reaction") {
      return;
    }

    let cancelled = false;
    let retryTimeoutId: number | null = null;

    if (!args.relayCoordinatorRef.current || args.readyReadRelayCount === 0) {
      retryTimeoutId = window.setTimeout(() => {
        setRetryRevision((current) => current + 1);
      }, 1_000);

      return () => {
        cancelled = true;
        if (retryTimeoutId !== null) {
          window.clearTimeout(retryTimeoutId);
        }
      };
    }

    async function loadReactions() {
      if (args.isResolvingSignerPubkey) {
        return;
      }

      if (!args.viewerPubkey) {
        setReactionLoadState("error");
        setReactionError(
          args.signerAvailable
            ? args.autoSignerPromptBlocked
              ? "NIP-07 が未承認です。NIP-07 または Reaction を押して再試行してください。"
              : "NIP-07 の承認が必要です。NIP-07 または Reaction を押してください。"
            : "公開鍵の入力または NIP-07 が必要です",
        );
        return;
      }

      if (accountRelayUrls.length === 0) {
        setReactionLoadState("error");
        setReactionError("read relay が設定されていません");
        return;
      }

      setReactionLoadState("loading");
      setReactionError(null);

      try {
        const pubkey = await ensureViewerPubkeyRef.current(args.manualPubkey);
        const sourceKey = `${accountRelayUrls.join(",")}:${pubkey}`;
        const sourceChanged = reactionSourceKeyRef.current !== sourceKey;
        if (cancelled) {
          return;
        }

        if (sourceChanged) {
          localReactionTargetIdsRef.current = [];
        }

        const relayTransport = {
          requestTemporaryEvents: async (
            relayUrl: string,
            filters: Parameters<RelayCoordinator["requestTemporaryEvents"]>[1],
            timeoutMs?: number,
          ) => {
            const coordinator = args.relayCoordinatorRef.current;

            if (!coordinator) {
              return [];
            }

            try {
              return await coordinator.requestTemporaryEvents(
                relayUrl,
                filters,
                timeoutMs,
              );
            } catch (error) {
              if (
                error instanceof Error
                && (
                  error.message === "relay is not connected"
                  || error.message === "relay client が初期化されていません"
                )
              ) {
                return [];
              }

              throw error;
            }
          },
        };

        const { targetEvents, targetIds } = await fetchRecentReactionNotesByAuthors(
          accountRelayUrls,
          [pubkey],
          args.timelineLimit,
          relayTransport,
        );

        if (cancelled) {
          return;
        }

        if (sourceChanged) {
          reactionSourceKeyRef.current = sourceKey;
        }

        const nextTargetIds = mergeReactionTargetIds(
          targetIds,
          localReactionTargetIdsRef.current,
          args.timelineLimit,
        );
        const snapshotItems = await ingestOverlayEventsRef.current(targetEvents);

        if (cancelled) {
          return;
        }

        setReactionTargetIds(nextTargetIds);
        setReactionTimeline((current) => {
          const next = nextTargetIds.length === 0
            ? []
            : orderReactionTimeline(
                mergeAuxiliaryTimeline({
                  currentItems: sourceChanged ? [] : current,
                  includeItem: (item) => nextTargetIds.includes(item.id),
                  profileSummaries: args.profileSummariesRef.current,
                  referenceItems: [
                    ...buildAuxiliaryTimeline({
                      events: targetEvents,
                      profileSummaries: args.profileSummariesRef.current,
                      referenceItems: snapshotItems ?? args.timelineRef.current,
                      timelineLimit: args.timelineLimit,
                    }),
                    ...(snapshotItems ?? args.timelineRef.current),
                  ],
                  timelineLimit: args.timelineLimit,
                }),
                nextTargetIds,
                args.timelineLimit,
              );

          return timelineItemsEqual(current, next) ? current : next;
        });
        setReactionLoadState("ready");
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (error instanceof UnsupportedSignerError) {
          markSignerUnavailableRef.current();
        }

        setReactionLoadState("error");
        setReactionError(error instanceof Error ? error.message : String(error));
      }
    }

    void loadReactions();

    return () => {
      cancelled = true;
      if (retryTimeoutId !== null) {
        window.clearTimeout(retryTimeoutId);
      }
    };
  }, [
    args.autoSignerPromptBlocked,
    args.isResolvingSignerPubkey,
    args.manualPubkey,
    args.relayBootstrapDeferred,
    args.relayConfigurationKey,
    args.signerAvailable,
    args.readyReadRelayCount,
    args.timelineLimit,
    args.timelineView,
    args.viewerPubkey,
    accountRelayUrls,
    retryRevision,
  ]);

  useEffect(() => {
    setReactionTimeline((current) => {
      if (reactionTargetIds.length === 0) {
        return current.length > 0 ? [] : current;
      }

      const next = orderReactionTimeline(
        mergeAuxiliaryTimeline({
          currentItems: current,
          includeItem: (item) => reactionTargetIds.includes(item.id),
          profileSummaries: args.profileSummariesRef.current,
          referenceItems: args.timeline,
          timelineLimit: args.timelineLimit,
        }),
        reactionTargetIds,
        args.timelineLimit,
      );

      return timelineItemsEqual(current, next) ? current : next;
    });
  }, [
    args.profileSummariesRef,
    args.timeline,
    args.timelineLimit,
    reactionTargetIds,
  ]);

  function clearReactionError() {
    setReactionError(null);
  }

  const resetReactionState = useCallback(() => {
    localReactionTargetIdsRef.current = [];
    reactionSourceKeyRef.current = null;
    setReactionLoadState("idle");
    setReactionError(null);
    setReactionTimeline([]);
    setReactionTargetIds([]);
  }, []);

  function primeReactionLoad() {
    setReactionLoadState((current) => (current === "idle" ? "loading" : current));
  }

  const rememberLocalReactionTarget = useCallback((item: TimelineItem) => {
    localReactionTargetIdsRef.current = mergeReactionTargetIds(
      [item.id],
      localReactionTargetIdsRef.current,
      args.timelineLimit,
    );

    setReactionTargetIds((currentIds) => {
      const nextTargetIds = mergeReactionTargetIds(
        [item.id],
        currentIds,
        args.timelineLimit,
      );

      setReactionTimeline((currentTimeline) => {
        const next = orderReactionTimeline(
          mergeAuxiliaryTimeline({
            currentItems: currentTimeline,
            includeItem: (candidate) => nextTargetIds.includes(candidate.id),
            profileSummaries: args.profileSummariesRef.current,
            referenceItems: [item, ...args.timeline],
            timelineLimit: args.timelineLimit,
          }),
          nextTargetIds,
          args.timelineLimit,
        );

        return timelineItemsEqual(currentTimeline, next) ? currentTimeline : next;
      });

      return nextTargetIds;
    });

    setReactionLoadState((current) => (current === "idle" ? "ready" : current));
    setReactionError(null);
  }, [
    args.profileSummariesRef,
    args.timeline,
    args.timelineLimit,
  ]);

  return {
    clearReactionError,
    primeReactionLoad,
    reactionError,
    reactionLoadState,
    reactionTimeline,
    rememberLocalReactionTarget,
    resetReactionState,
  };
}

function mergeReactionTargetIds(preferredIds: string[], currentIds: string[], limit: number) {
  return [...new Set([...preferredIds, ...currentIds])].slice(0, limit);
}

function orderReactionTimeline(items: TimelineItem[], targetIds: string[], limit: number) {
  const itemsById = new Map(items.map((item) => [item.id, item]));

  return targetIds
    .map((targetId) => itemsById.get(targetId) ?? null)
    .filter((item): item is TimelineItem => item !== null)
    .slice(0, limit);
}
