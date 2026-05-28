import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type { AuxiliaryLoadState, TimelineView } from "../app/types";
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
  const [retryRevision, setRetryRevision] = useState(0);

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
          requestTemporaryLatestEvent: async (
            relayUrl: string,
            filters: Parameters<RelayCoordinator["requestTemporaryLatestEvent"]>[1],
            timeoutMs?: number,
          ) => {
            const coordinator = args.relayCoordinatorRef.current;

            if (!coordinator) {
              return null;
            }

            try {
              return await coordinator.requestTemporaryLatestEvent(
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
                return null;
              }

              throw error;
            }
          },
        };
        const targets =
          followSourceKey === sourceKey
            ? followTargets
            : await fetchFollowTargets(accountRelayUrls, pubkey, relayTransport);

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
          relayTransport,
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
      if (retryTimeoutId !== null) {
        window.clearTimeout(retryTimeoutId);
      }
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
    retryRevision,
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
  }, []);

  function primeFollowLoad() {
    setFollowLoadState((current) => (current === "idle" ? "loading" : current));
  }

  return {
    clearFollowError,
    followError,
    followLoadState,
    followTimeline,
    primeFollowLoad,
    resetFollowState,
  };
}
