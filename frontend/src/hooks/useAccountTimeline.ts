import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { normalizeHexPubkey } from "../lib/nostr/pubkey";
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
import { fetchRecentNotesByAuthors } from "../lib/nostr/contacts";
import type {
  AuxiliaryLoadState,
  AuxiliaryTimelineDiagnostic,
  TimelineView,
} from "../app/types";
import { useTemporaryRelayTransport } from "./useTemporaryRelayTransport";

type UseAccountTimelineArgs = {
  autoSignerPromptBlocked: boolean;
  ensureViewerPubkey: (manualPubkey: string | null) => Promise<string>;
  ingestOverlayEvents: (events: NostrEvent[]) => Promise<TimelineItem[] | null>;
  isResolvingSignerPubkey: boolean;
  manualPubkey: string | null;
  markSignerUnavailable: () => void;
  prefetchAccountTimeline: boolean;
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

export function useAccountTimeline(args: UseAccountTimelineArgs) {
  const [accountLoadState, setAccountLoadState] = useState<AuxiliaryLoadState>("idle");
  const [accountSourceKey, setAccountSourceKey] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountTimeline, setAccountTimeline] = useState<TimelineItem[]>([]);
  const [accountFetchMeta, setAccountFetchMeta] = useState<{
    noteCount: number;
    lastFetchedAt: number | null;
  }>({
    noteCount: 0,
    lastFetchedAt: null,
  });
  const shouldPrefetchAccount =
    args.prefetchAccountTimeline
    && Boolean(args.viewerPubkey);
  const oneShotTransport = useTemporaryRelayTransport({
    active:
      args.timelineView === "follow"
      || args.timelineView === "account"
      || shouldPrefetchAccount,
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

    if (
      args.timelineView !== "follow"
      && args.timelineView !== "account"
      && !shouldPrefetchAccount
    ) {
      return;
    }

    let cancelled = false;

    async function loadAccount() {
      if (args.isResolvingSignerPubkey) {
        return;
      }

      if (!args.viewerPubkey) {
        setAccountLoadState("error");
        setAccountError(
          args.signerAvailable
            ? args.autoSignerPromptBlocked
              ? "NIP-07 が未承認です。NIP-07 または Follow を押して再試行してください。"
              : "NIP-07 の承認が必要です。NIP-07 または Follow を押してください。"
            : "公開鍵の入力または NIP-07 が必要です",
        );
        return;
      }

      if (args.readRelayUrls.length === 0) {
        setAccountLoadState("error");
        setAccountError("read relay が設定されていません");
        return;
      }

      if (!oneShotTransport.ready) {
        setAccountLoadState("waiting");
        setAccountError(null);
        return;
      }

      setAccountLoadState("loading");
      setAccountError(null);

      try {
        const pubkey = await ensureViewerPubkeyRef.current(args.manualPubkey);
        const accountRelayUrls = loadAccountRelayUrls(args.readRelayUrls);
        const sourceKey = `${accountRelayUrls.join(",")}:${pubkey}`;

        if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
          console.info("[account:load]", {
            pubkey,
            relayUrls: accountRelayUrls,
            sourceKey,
          });
        }

        if (cancelled) {
          return;
        }

        if (accountSourceKey !== sourceKey) {
          setAccountTimeline([]);
        }

        const events = await fetchRecentNotesByAuthors(
          accountRelayUrls,
          [pubkey],
          args.timelineLimit,
          oneShotTransport.relayTransport,
        );

        if (cancelled) {
          return;
        }

        if (accountSourceKey !== sourceKey) {
          setAccountSourceKey(sourceKey);
        }

        const snapshotItems = await ingestOverlayEventsRef.current(events);

        if (cancelled) {
          return;
        }

        setAccountTimeline(
          buildAuxiliaryTimeline({
            events,
            profileSummaries: args.profileSummariesRef.current,
            referenceItems: snapshotItems ?? args.timelineRef.current,
            timelineLimit: args.timelineLimit,
          }),
        );

        if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
          console.info("[account:load_result]", {
            noteCount: events.length,
          });
        }

        setAccountFetchMeta({
          noteCount: events.length,
          lastFetchedAt: Date.now(),
        });
        setAccountLoadState("ready");
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (error instanceof UnsupportedSignerError) {
          markSignerUnavailableRef.current();
        }

        setAccountLoadState("error");
        setAccountError(error instanceof Error ? error.message : String(error));
      }
    }

    void loadAccount();

    return () => {
      cancelled = true;
    };
  }, [
    accountSourceKey,
    args.autoSignerPromptBlocked,
    args.isResolvingSignerPubkey,
    args.manualPubkey,
    args.profileSummariesRef,
    args.prefetchAccountTimeline,
    args.relayBootstrapDeferred,
    args.relayConfigurationKey,
    args.relayCoordinatorRef,
    args.readyReadRelayCount,
    args.signerAvailable,
    args.timelineLimit,
    args.timelineRef,
    args.timelineView,
    args.viewerPubkey,
    oneShotTransport.ready,
    oneShotTransport.relayTransport,
    shouldPrefetchAccount,
  ]);

  useEffect(() => {
    setAccountTimeline((current) => {
      if (!args.viewerPubkey) {
        return current.length > 0 ? [] : current;
      }

      const normalizedViewerPubkey = normalizeHexPubkey(args.viewerPubkey);
      const next = mergeAuxiliaryTimeline({
        currentItems: current,
        includeItem: (item) => item.pubkey === normalizedViewerPubkey,
        profileSummaries: args.profileSummariesRef.current,
        referenceItems: args.timeline,
        timelineLimit: args.timelineLimit,
      });

      return timelineItemsEqual(current, next) ? current : next;
    });
  }, [
    args.profileSummariesRef,
    args.timeline,
    args.timelineLimit,
    args.viewerPubkey,
  ]);

  function clearAccountError() {
    setAccountError(null);
  }

  const resetAccountState = useCallback(() => {
    setAccountLoadState("idle");
    setAccountSourceKey(null);
    setAccountError(null);
    setAccountTimeline([]);
    setAccountFetchMeta({
      noteCount: 0,
      lastFetchedAt: null,
    });
  }, []);

  function primeAccountLoad() {
    setAccountLoadState((current) => (current === "idle" ? "loading" : current));
  }

  const accountDiagnostic = useMemo<AuxiliaryTimelineDiagnostic>(
    () => ({
      label: "Account",
      loadState: accountLoadState,
      relayCount: accountRelayUrls.length,
      readyReadRelayCount: args.readyReadRelayCount,
      itemCount: accountTimeline.length,
      summary:
        accountFetchMeta.lastFetchedAt === null
          ? null
          : `notes ${accountFetchMeta.noteCount}`,
      lastFetchedAt: accountFetchMeta.lastFetchedAt,
      error: accountError,
    }),
    [
      accountError,
      accountFetchMeta.lastFetchedAt,
      accountFetchMeta.noteCount,
      accountLoadState,
      accountRelayUrls.length,
      accountTimeline.length,
      args.readyReadRelayCount,
    ],
  );

  return {
    accountDiagnostic,
    accountError,
    accountLoadState,
    accountTimeline,
    clearAccountError,
    primeAccountLoad,
    resetAccountState,
  };
}
