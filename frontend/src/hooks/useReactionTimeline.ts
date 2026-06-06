import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type {
  AuxiliaryLoadState,
  AuxiliaryTimelineDiagnostic,
  TimelineView,
} from "../app/types";
import {
  fetchRecentReactionNotesByAuthors,
  findReactionTargetId,
} from "../lib/nostr/contacts";
import {
  resolveReactionIntent,
  type ReactionIntent,
  type ViewerReactionState,
} from "../lib/nostr/reaction";
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
import { useTemporaryRelayTransport } from "./useTemporaryRelayTransport";

type UseReactionTimelineArgs = {
  autoSignerPromptBlocked: boolean;
  ensureViewerPubkey: (manualPubkey: string | null) => Promise<string>;
  ingestOverlayEvents: (events: NostrEvent[]) => Promise<TimelineItem[] | null>;
  isResolvingSignerPubkey: boolean;
  manualPubkey: string | null;
  markSignerUnavailable: () => void;
  profileSummariesRef: MutableRefObject<Map<string, TimelineProfile>>;
  readRelayUrls: string[];
  reactionTabEnabled: boolean;
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
  const [viewerReactionStateByTargetId, setViewerReactionStateByTargetId] = useState<
    Record<string, ViewerReactionState>
  >({});
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [reactionFetchMeta, setReactionFetchMeta] = useState<{
    targetCount: number;
    lastFetchedAt: number | null;
    lastEventAt: number | null;
    liveEventCount: number;
  }>({
    targetCount: 0,
    lastFetchedAt: null,
    lastEventAt: null,
    liveEventCount: 0,
  });
  const shouldPrefetchReaction =
    args.reactionTabEnabled
    && Boolean(args.viewerPubkey);
  const oneShotTransport = useTemporaryRelayTransport({
    active: args.timelineView === "reaction" || shouldPrefetchReaction,
    relayBootstrapDeferred: args.relayBootstrapDeferred,
    relayCoordinatorRef: args.relayCoordinatorRef,
    readyReadRelayCount: args.readyReadRelayCount,
  });

  const accountRelayUrls = useMemo(
    () => loadAccountRelayUrls(args.readRelayUrls),
    [args.relayConfigurationKey],
  );
  const ensureViewerPubkeyRef = useRef(args.ensureViewerPubkey);
  const ingestOverlayEventsRef = useRef(args.ingestOverlayEvents);
  const markSignerUnavailableRef = useRef(args.markSignerUnavailable);
  const localReactionTargetIdsRef = useRef<string[]>([]);
  const localViewerReactionStateByTargetIdRef = useRef<Record<string, ViewerReactionState>>({});
  const reactionSourceKeyRef = useRef<string | null>(null);
  const liveReactionEventIdsRef = useRef<string[]>([]);

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
    if (args.viewerPubkey) {
      return;
    }

    liveReactionEventIdsRef.current = [];
    localViewerReactionStateByTargetIdRef.current = {};
    setViewerReactionStateByTargetId((current) => (
      Object.keys(current).length > 0 ? {} : current
    ));
  }, [args.viewerPubkey]);

  useEffect(() => {
    if (!args.reactionTabEnabled) {
      liveReactionEventIdsRef.current = [];
    }
  }, [args.reactionTabEnabled]);

  useEffect(() => {
    const coordinator = args.relayCoordinatorRef.current;

    if (!coordinator) {
      return;
    }

    if (
      args.relayBootstrapDeferred
      || !args.reactionTabEnabled
      || !args.viewerPubkey
      || accountRelayUrls.length === 0
    ) {
      coordinator.setReactionListener(null);
      coordinator.setReactionFilters(null);
      return;
    }

    const viewerPubkey = args.viewerPubkey;
    const since = Math.max(0, Math.floor(Date.now() / 1000) - 5);

    coordinator.setReactionListener((context) => {
      if (context.event.kind !== 7) {
        return;
      }

      if (normalizeReactionPubkey(context.event.pubkey) !== viewerPubkey) {
        return;
      }

      if (!rememberLiveReactionEventId(liveReactionEventIdsRef.current, context.event.id)) {
        return;
      }

      const targetId = findReactionTargetId(context.event);
      const reactionIntent = resolveReactionIntent(context.event.content);

      if (targetId && reactionIntent) {
        localViewerReactionStateByTargetIdRef.current = setViewerReactionIntent(
          localViewerReactionStateByTargetIdRef.current,
          targetId,
          reactionIntent,
        );
        setViewerReactionStateByTargetId((current) =>
          setViewerReactionIntent(current, targetId, reactionIntent),
        );
      }

      setReactionFetchMeta((current) => ({
        ...current,
        lastEventAt: Date.now(),
        liveEventCount: current.liveEventCount + 1,
      }));
      setRefreshRevision((current) => current + 1);
    });
    coordinator.setReactionFilters((relayUrl) => {
      if (!accountRelayUrls.includes(relayUrl)) {
        return null;
      }

      return [
        {
          kinds: [7],
          authors: [viewerPubkey],
          since,
        },
      ];
    });

    return () => {
      coordinator.setReactionListener(null);
      coordinator.setReactionFilters(null);
    };
  }, [
    args.reactionTabEnabled,
    args.relayBootstrapDeferred,
    args.relayConfigurationKey,
    args.relayCoordinatorRef,
    args.viewerPubkey,
    accountRelayUrls,
  ]);

  useEffect(() => {
    if (args.relayBootstrapDeferred) {
      return;
    }

    if (args.timelineView !== "reaction" && !shouldPrefetchReaction) {
      return;
    }

    let cancelled = false;

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

      if (!oneShotTransport.ready) {
        setReactionLoadState("waiting");
        setReactionError(null);
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
          localViewerReactionStateByTargetIdRef.current = {};
        }

        const { reactionEvents, targetEvents, targetIds } = await fetchRecentReactionNotesByAuthors(
          accountRelayUrls,
          [pubkey],
          args.timelineLimit,
          oneShotTransport.relayTransport,
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
        const nextViewerReactionStateByTargetId = mergeViewerReactionStateByTargetId(
          buildViewerReactionStateByTargetId(reactionEvents),
          localViewerReactionStateByTargetIdRef.current,
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
        setReactionFetchMeta((current) => ({
          targetCount: nextTargetIds.length,
          lastFetchedAt: Date.now(),
          lastEventAt: current.lastEventAt,
          liveEventCount: current.liveEventCount,
        }));
        setViewerReactionStateByTargetId((current) => (
          viewerReactionStateByTargetIdEqual(current, nextViewerReactionStateByTargetId)
            ? current
            : nextViewerReactionStateByTargetId
        ));
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
    };
  }, [
    args.autoSignerPromptBlocked,
    args.isResolvingSignerPubkey,
    args.manualPubkey,
    args.reactionTabEnabled,
    args.relayBootstrapDeferred,
    args.relayConfigurationKey,
    args.signerAvailable,
    args.readyReadRelayCount,
    args.timelineLimit,
    args.timelineView,
    args.viewerPubkey,
    accountRelayUrls,
    oneShotTransport.ready,
    oneShotTransport.relayTransport,
    refreshRevision,
    shouldPrefetchReaction,
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
    localViewerReactionStateByTargetIdRef.current = {};
    reactionSourceKeyRef.current = null;
    setReactionLoadState("idle");
    setReactionError(null);
    setReactionTimeline([]);
    setReactionTargetIds([]);
    setViewerReactionStateByTargetId({});
    setRefreshRevision(0);
    setReactionFetchMeta({
      targetCount: 0,
      lastFetchedAt: null,
      lastEventAt: null,
      liveEventCount: 0,
    });
  }, []);

  function primeReactionLoad() {
    setReactionLoadState((current) => (current === "idle" ? "loading" : current));
  }

  const rememberLocalReactionTarget = useCallback((
    item: TimelineItem,
    reactionIntent: ReactionIntent,
  ) => {
    localReactionTargetIdsRef.current = mergeReactionTargetIds(
      [item.id],
      localReactionTargetIdsRef.current,
      args.timelineLimit,
    );
    localViewerReactionStateByTargetIdRef.current = setViewerReactionIntent(
      localViewerReactionStateByTargetIdRef.current,
      item.id,
      reactionIntent,
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
    setViewerReactionStateByTargetId((current) =>
      setViewerReactionIntent(current, item.id, reactionIntent),
    );

    setReactionLoadState((current) => (current === "idle" ? "ready" : current));
    setReactionError(null);
    setReactionFetchMeta((current) => ({
      targetCount: localReactionTargetIdsRef.current.length,
      lastFetchedAt: Date.now(),
      lastEventAt: current.lastEventAt,
      liveEventCount: current.liveEventCount,
    }));
  }, [
    args.profileSummariesRef,
    args.timeline,
    args.timelineLimit,
  ]);

  const reactionDiagnosticLoadState: AuxiliaryLoadState =
    reactionLoadState === "ready"
    && args.reactionTabEnabled
    && Boolean(args.viewerPubkey)
    && accountRelayUrls.length > 0
    && args.readyReadRelayCount > 0
      ? "listening"
      : reactionLoadState;

  const reactionDiagnostic = useMemo<AuxiliaryTimelineDiagnostic>(
    () => ({
      label: "Reaction",
      loadState: reactionDiagnosticLoadState,
      relayCount: accountRelayUrls.length,
      readyReadRelayCount: args.readyReadRelayCount,
      itemCount: reactionTimeline.length,
      summary:
        reactionFetchMeta.lastFetchedAt === null
          ? null
          : `targets ${reactionFetchMeta.targetCount}`,
      lastFetchedAt: reactionFetchMeta.lastFetchedAt,
      lastEventAt: reactionFetchMeta.lastEventAt,
      liveEventCount: reactionFetchMeta.liveEventCount,
      error: reactionError,
    }),
    [
      accountRelayUrls.length,
      args.readyReadRelayCount,
      args.reactionTabEnabled,
      args.viewerPubkey,
      reactionError,
      reactionDiagnosticLoadState,
      reactionFetchMeta.lastEventAt,
      reactionFetchMeta.lastFetchedAt,
      reactionFetchMeta.liveEventCount,
      reactionFetchMeta.targetCount,
      reactionTimeline.length,
    ],
  );

  return {
    clearReactionError,
    primeReactionLoad,
    reactionDiagnostic,
    reactionError,
    reactionLoadState,
    reactionTimeline,
    rememberLocalReactionTarget,
    resetReactionState,
    viewerReactionStateByTargetId,
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

function normalizeReactionPubkey(pubkey: string | undefined) {
  if (!pubkey) {
    return null;
  }

  const normalized = pubkey.trim().toLowerCase();
  return normalized.length === 64 ? normalized : null;
}

function buildViewerReactionStateByTargetId(events: NostrEvent[]) {
  let nextStateByTargetId: Record<string, ViewerReactionState> = {};

  for (const event of events) {
    if (event.kind !== 7) {
      continue;
    }

    const targetId = findReactionTargetId(event);
    const reactionIntent = resolveReactionIntent(event.content);

    if (!targetId || !reactionIntent) {
      continue;
    }

    nextStateByTargetId = setViewerReactionIntent(
      nextStateByTargetId,
      targetId,
      reactionIntent,
    );
  }

  return nextStateByTargetId;
}

function mergeViewerReactionStateByTargetId(
  current: Readonly<Record<string, ViewerReactionState>>,
  next: Readonly<Record<string, ViewerReactionState>>,
) {
  let mergedStateByTargetId = { ...current };

  for (const [targetId, reactionState] of Object.entries(next)) {
    if (reactionState.like) {
      mergedStateByTargetId = setViewerReactionIntent(
        mergedStateByTargetId,
        targetId,
        "like",
      );
    }

    if (reactionState.kusa) {
      mergedStateByTargetId = setViewerReactionIntent(
        mergedStateByTargetId,
        targetId,
        "kusa",
      );
    }
  }

  return mergedStateByTargetId;
}

function setViewerReactionIntent(
  current: Readonly<Record<string, ViewerReactionState>>,
  targetId: string,
  reactionIntent: ReactionIntent,
) {
  const currentReactionState = current[targetId];

  if (currentReactionState?.[reactionIntent]) {
    return current as Record<string, ViewerReactionState>;
  }

  return {
    ...current,
    [targetId]: {
      like: reactionIntent === "like" || currentReactionState?.like === true,
      kusa: reactionIntent === "kusa" || currentReactionState?.kusa === true,
    },
  };
}

function viewerReactionStateByTargetIdEqual(
  left: Readonly<Record<string, ViewerReactionState>>,
  right: Readonly<Record<string, ViewerReactionState>>,
) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every((targetId) => (
    left[targetId]?.like === right[targetId]?.like
    && left[targetId]?.kusa === right[targetId]?.kusa
  ));
}

function rememberLiveReactionEventId(eventIds: string[], eventId: string) {
  if (eventIds.includes(eventId)) {
    return false;
  }

  eventIds.push(eventId);

  if (eventIds.length > 256) {
    eventIds.splice(0, eventIds.length - 256);
  }

  return true;
}
