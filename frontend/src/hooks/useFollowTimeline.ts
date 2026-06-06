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
  fetchFollowTargets,
  fetchRecentNotesForFollowTargets,
  type FollowTarget,
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
import { useTemporaryRelayTransport } from "./useTemporaryRelayTransport";

type UseFollowTimelineArgs = {
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

export function useFollowTimeline(args: UseFollowTimelineArgs) {
  const [followLoadState, setFollowLoadState] = useState<AuxiliaryLoadState>("idle");
  const [followTargets, setFollowTargets] = useState<FollowTarget[]>([]);
  const [followSourceKey, setFollowSourceKey] = useState<string | null>(null);
  const [followError, setFollowError] = useState<string | null>(null);
  const [followTimeline, setFollowTimeline] = useState<TimelineItem[]>([]);
  const [followFetchMeta, setFollowFetchMeta] = useState<{
    targetCount: number;
    noteCount: number;
    lastFetchedAt: number | null;
  }>({
    targetCount: 0,
    noteCount: 0,
    lastFetchedAt: null,
  });
  const oneShotTransport = useTemporaryRelayTransport({
    active: args.timelineView === "follow",
    relayBootstrapDeferred: args.relayBootstrapDeferred,
    relayCoordinatorRef: args.relayCoordinatorRef,
    readyReadRelayCount: args.readyReadRelayCount,
  });

  const ensureViewerPubkeyRef = useRef(args.ensureViewerPubkey);
  const ingestOverlayEventsRef = useRef(args.ingestOverlayEvents);
  const markSignerUnavailableRef = useRef(args.markSignerUnavailable);

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

    if (args.timelineView !== "follow") {
      return;
    }

    let cancelled = false;

    async function loadFollows() {
      if (args.isResolvingSignerPubkey) {
        return;
      }

      if (!args.viewerPubkey) {
        setFollowLoadState("error");
        setFollowError(
          args.signerAvailable
            ? args.autoSignerPromptBlocked
              ? "NIP-07 が未承認です。NIP-07 または Follow を押して再試行してください。"
              : "NIP-07 の承認が必要です。NIP-07 または Follow を押してください。"
            : "公開鍵の入力または NIP-07 が必要です",
        );
        return;
      }

      if (args.readRelayUrls.length === 0) {
        setFollowLoadState("error");
        setFollowError("read relay が設定されていません");
        return;
      }

      if (!oneShotTransport.ready) {
        setFollowLoadState("waiting");
        setFollowError(null);
        return;
      }

      setFollowLoadState("loading");
      setFollowError(null);

      try {
        const pubkey = await ensureViewerPubkeyRef.current(args.manualPubkey);
        const accountRelayUrls = loadAccountRelayUrls(args.readRelayUrls);
        const sourceKey = `${accountRelayUrls.join(",")}:${pubkey}`;

        if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
          console.info("[follow:load]", {
            pubkey,
            relayUrls: accountRelayUrls,
            sourceKey,
          });
        }

        if (cancelled) {
          return;
        }

        if (followSourceKey !== sourceKey) {
          setFollowTimeline([]);
        }

        const targets =
          followSourceKey === sourceKey
            ? followTargets
            : await fetchFollowTargets(
              accountRelayUrls,
              pubkey,
              oneShotTransport.relayTransport,
            );

        if (cancelled) {
          return;
        }

        if (followSourceKey !== sourceKey) {
          setFollowTargets(targets);
          setFollowSourceKey(sourceKey);
        }

        const events = await fetchRecentNotesForFollowTargets(
          accountRelayUrls,
          targets,
          args.timelineLimit,
          oneShotTransport.relayTransport,
          [1, 6],
        );

        if (cancelled) {
          return;
        }

        const snapshotItems = await ingestOverlayEventsRef.current(events);

        if (cancelled) {
          return;
        }

        setFollowTimeline(
          buildAuxiliaryTimeline({
            events,
            profileSummaries: args.profileSummariesRef.current,
            referenceItems: snapshotItems ?? args.timelineRef.current,
            timelineLimit: args.timelineLimit,
          }),
        );

        if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
          console.info("[follow:load_result]", {
            targetCount: targets.length,
            noteCount: events.length,
          });
        }

        setFollowFetchMeta({
          targetCount: targets.length,
          noteCount: events.length,
          lastFetchedAt: Date.now(),
        });
        setFollowLoadState("ready");
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (error instanceof UnsupportedSignerError) {
          markSignerUnavailableRef.current();
        }

        setFollowLoadState("error");
        setFollowError(error instanceof Error ? error.message : String(error));
      }
    }

    void loadFollows();

    return () => {
      cancelled = true;
    };
  }, [
    args.autoSignerPromptBlocked,
    args.isResolvingSignerPubkey,
    args.manualPubkey,
    args.profileSummariesRef,
    args.relayBootstrapDeferred,
    args.relayConfigurationKey,
    args.relayCoordinatorRef,
    args.readyReadRelayCount,
    args.signerAvailable,
    args.timelineLimit,
    args.timelineRef,
    args.timelineView,
    args.viewerPubkey,
    followSourceKey,
    followTargets,
    oneShotTransport.ready,
    oneShotTransport.relayTransport,
  ]);

  useEffect(() => {
    const followPubkeys = new Set(followTargets.map((target) => target.pubkey));

    setFollowTimeline((current) => {
      const next = followSourceKey
        ? mergeAuxiliaryTimeline({
            currentItems: current,
            includeItem: (item) => followPubkeys.has(item.pubkey),
            profileSummaries: args.profileSummariesRef.current,
            referenceItems: args.timeline,
            timelineLimit: args.timelineLimit,
          })
        : current.length > 0 ? [] : current;

      return timelineItemsEqual(current, next) ? current : next;
    });
  }, [
    args.profileSummariesRef,
    args.timeline,
    args.timelineLimit,
    followSourceKey,
    followTargets,
  ]);

  function clearFollowError() {
    setFollowError(null);
  }

  const resetFollowState = useCallback(() => {
    setFollowLoadState("idle");
    setFollowTargets([]);
    setFollowSourceKey(null);
    setFollowError(null);
    setFollowTimeline([]);
    setFollowFetchMeta({
      targetCount: 0,
      noteCount: 0,
      lastFetchedAt: null,
    });
  }, []);

  function primeFollowLoad() {
    setFollowLoadState((current) => (current === "idle" ? "loading" : current));
  }

  const followDiagnostic = useMemo<AuxiliaryTimelineDiagnostic>(
    () => ({
      label: "Follow",
      loadState: followLoadState,
      relayCount: args.readRelayUrls.length,
      readyReadRelayCount: args.readyReadRelayCount,
      itemCount: followTimeline.length,
      summary:
        followFetchMeta.lastFetchedAt === null
          ? null
          : `targets ${followFetchMeta.targetCount} / notes ${followFetchMeta.noteCount}`,
      lastFetchedAt: followFetchMeta.lastFetchedAt,
      lastEventAt: null,
      liveEventCount: null,
      error: followError,
    }),
    [
      args.readRelayUrls.length,
      args.readyReadRelayCount,
      followError,
      followFetchMeta.lastFetchedAt,
      followFetchMeta.noteCount,
      followFetchMeta.targetCount,
      followLoadState,
      followTimeline.length,
    ],
  );

  return {
    clearFollowError,
    followDiagnostic,
    followError,
    followLoadState,
    followTimeline,
    primeFollowLoad,
    resetFollowState,
  };
}
