import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type { AuxiliaryLoadState, TimelineView } from "../app/types";
import { fetchRecentNotifyEventsByPubkey } from "../lib/nostr/contacts";
import { findReactionTargetId } from "../lib/nostr/contacts";
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

const NOTIFY_REFRESH_INTERVAL_MS = 15_000;

type UseNotifyTimelineArgs = {
  accountTimeline: TimelineItem[];
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

export function useNotifyTimeline(args: UseNotifyTimelineArgs) {
  const [notifyLoadState, setNotifyLoadState] = useState<AuxiliaryLoadState>("idle");
  const [notifyError, setNotifyError] = useState<string | null>(null);
  const [notifyTimeline, setNotifyTimeline] = useState<TimelineItem[]>([]);
  const [notifyEventIds, setNotifyEventIds] = useState<string[]>([]);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const oneShotTransport = useTemporaryRelayTransport({
    active: args.timelineView === "notify",
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
  const knownNotifyTargetEventIdsRef = useRef<Set<string>>(new Set());
  const notifyTimelineRef = useRef<TimelineItem[]>([]);

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
    notifyTimelineRef.current = notifyTimeline;
  }, [notifyTimeline]);

  useEffect(() => {
    if (args.relayBootstrapDeferred || args.timelineView !== "notify") {
      return;
    }

    const intervalId = window.setInterval(() => {
      setRefreshRevision((current) => current + 1);
    }, NOTIFY_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [args.relayBootstrapDeferred, args.timelineView]);

  useEffect(() => {
    if (args.relayBootstrapDeferred) {
      return;
    }

    if (args.timelineView !== "notify") {
      return;
    }

    let cancelled = false;

    async function loadNotifications() {
      if (args.isResolvingSignerPubkey) {
        return;
      }

      if (!args.viewerPubkey) {
        setNotifyLoadState("error");
        setNotifyError(
          args.signerAvailable
            ? args.autoSignerPromptBlocked
              ? "NIP-07 が未承認です。NIP-07 または Notify を押して再試行してください。"
              : "NIP-07 の承認が必要です。NIP-07 または Notify を押してください。"
            : "公開鍵の入力または NIP-07 が必要です",
        );
        return;
      }

      if (accountRelayUrls.length === 0) {
        setNotifyLoadState("error");
        setNotifyError("read relay が設定されていません");
        return;
      }

      if (!oneShotTransport.ready) {
        setNotifyLoadState("waiting");
        setNotifyError(null);
        return;
      }

      setNotifyLoadState("loading");
      setNotifyError(null);

      try {
        const pubkey = await ensureViewerPubkeyRef.current(args.manualPubkey);
        if (cancelled) {
          return;
        }

        const knownTargetEventIds = collectKnownNotifyTargetEventIds(
          [...args.accountTimeline, ...args.timelineRef.current],
          knownNotifyTargetEventIdsRef.current,
        );

        const {
          notificationEvents,
          reactionTargetEventsByReactionId,
        } = await fetchRecentNotifyEventsByPubkey(
          accountRelayUrls,
          pubkey,
          args.timelineLimit,
          oneShotTransport.relayTransport,
          knownTargetEventIds,
        );

        if (cancelled) {
          return;
        }

        const reactionTargetEvents = [
          ...new Map(
            [...reactionTargetEventsByReactionId.values()].map((event) => [event.id, event]),
          ).values(),
        ];
        const snapshotItems = await ingestOverlayEventsRef.current([
          ...notificationEvents,
          ...reactionTargetEvents,
        ]);
        const referenceItems = [
          ...args.accountTimeline,
          ...(snapshotItems ?? []),
          ...args.timelineRef.current,
        ];

        if (cancelled) {
          return;
        }

        const nextItems = buildNotifyTimelineItems({
          notificationEvents,
          previousItems: notifyTimelineRef.current,
          profileSummaries: args.profileSummariesRef.current,
          reactionTargetEventsByReactionId,
          referenceItems,
          timelineLimit: args.timelineLimit,
        });
        knownNotifyTargetEventIdsRef.current = collectKnownNotifyTargetEventIds(
          referenceItems,
          knownNotifyTargetEventIdsRef.current,
        );

        setNotifyEventIds(notificationEvents.map((event) => event.id));
        setNotifyTimeline(nextItems);
        setNotifyLoadState("ready");
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (error instanceof UnsupportedSignerError) {
          markSignerUnavailableRef.current();
        }

        setNotifyLoadState("error");
        setNotifyError(error instanceof Error ? error.message : String(error));
      }
    }

    void loadNotifications();

    return () => {
      cancelled = true;
    };
  }, [
    args.autoSignerPromptBlocked,
    args.accountTimeline,
    args.isResolvingSignerPubkey,
    args.manualPubkey,
    args.relayBootstrapDeferred,
    args.relayConfigurationKey,
    args.signerAvailable,
    args.readyReadRelayCount,
    args.timelineLimit,
    args.timelineView,
    args.viewerPubkey,
    refreshRevision,
    accountRelayUrls,
    oneShotTransport.ready,
    oneShotTransport.relayTransport,
  ]);

  useEffect(() => {
    setNotifyTimeline((current) => {
      if (notifyEventIds.length === 0) {
        return current.length > 0 ? [] : current;
      }

      const currentItemsById = new Map(current.map((item) => [item.id, item]));

      const next = orderNotifyTimeline(
        mergeAuxiliaryTimeline({
          currentItems: current,
          includeItem: (item) => notifyEventIds.includes(item.id),
          profileSummaries: args.profileSummariesRef.current,
          referenceItems: [...args.accountTimeline, ...args.timeline],
          timelineLimit: args.timelineLimit,
        }),
        notifyEventIds,
        args.timelineLimit,
      ).map((item) =>
        hydrateNotifyTimelineItem({
          item,
          previousItem: currentItemsById.get(item.id),
          profileSummaries: args.profileSummariesRef.current,
          referenceItems: [...current, ...args.accountTimeline, ...args.timeline],
        }),
      );

      return timelineItemsEqual(current, next) ? current : next;
    });
  }, [
    args.profileSummariesRef,
    args.accountTimeline,
    args.timeline,
    args.timelineLimit,
    notifyEventIds,
  ]);

  function clearNotifyError() {
    setNotifyError(null);
  }

  const resetNotifyState = useCallback(() => {
    setNotifyLoadState("idle");
    setNotifyError(null);
    setNotifyTimeline([]);
    setNotifyEventIds([]);
    setRefreshRevision(0);
    knownNotifyTargetEventIdsRef.current = new Set();
    notifyTimelineRef.current = [];
  }, []);

  function primeNotifyLoad() {
    setNotifyLoadState((current) => (current === "idle" ? "loading" : current));
    setRefreshRevision((current) => current + 1);
  }

  return {
    clearNotifyError,
    notifyError,
    notifyLoadState,
    notifyTimeline,
    primeNotifyLoad,
    resetNotifyState,
  };
}

function orderNotifyTimeline(items: TimelineItem[], eventIds: string[], limit: number) {
  const itemsById = new Map(items.map((item) => [item.id, item]));

  return eventIds
    .map((eventId) => itemsById.get(eventId) ?? null)
    .filter((item): item is TimelineItem => item !== null)
    .slice(0, limit);
}

function collectKnownNotifyTargetEventIds(
  referenceItems: TimelineItem[],
  knownTargetEventIds: ReadonlySet<string>,
) {
  const nextKnownIds = new Set<string>(knownTargetEventIds);

  for (const item of referenceItems) {
    nextKnownIds.add(item.id);
  }

  return nextKnownIds;
}

function buildNotifyTimelineItems(args: {
  notificationEvents: NostrEvent[];
  previousItems: TimelineItem[];
  profileSummaries: Map<string, TimelineProfile>;
  reactionTargetEventsByReactionId: Map<string, NostrEvent>;
  referenceItems: TimelineItem[];
  timelineLimit: number;
}) {
  const reactionTargetEvents = [
    ...new Map(
      [...args.reactionTargetEventsByReactionId.values()].map((event) => [event.id, event]),
    ).values(),
  ];
  const targetItems = reactionTargetEvents.length > 0
    ? buildAuxiliaryTimeline({
        events: reactionTargetEvents,
        profileSummaries: args.profileSummaries,
        referenceItems: args.referenceItems,
        timelineLimit: args.timelineLimit,
      })
    : [];
  const referenceById = new Map(
    [...targetItems, ...args.referenceItems].map((item) => [item.id, item]),
  );
  const reactionEventsById = new Map(
    args.notificationEvents
      .filter((event) => event.kind === 7)
      .map((event) => [event.id, event]),
  );
  const previousItemsById = new Map(args.previousItems.map((item) => [item.id, item]));

  return buildAuxiliaryTimeline({
    events: args.notificationEvents,
    profileSummaries: args.profileSummaries,
    referenceItems: [...targetItems, ...args.referenceItems],
    timelineLimit: args.timelineLimit,
  }).map((item) =>
    hydrateNotifyTimelineItem({
      item,
      previousItem: previousItemsById.get(item.id),
      profileSummaries: args.profileSummaries,
      reactionEvent: reactionEventsById.get(item.id),
      reactionTargetEvent: args.reactionTargetEventsByReactionId.get(item.id),
      referenceById,
    }),
  );
}

function hydrateNotifyTimelineItem(args: {
  item: TimelineItem;
  previousItem?: TimelineItem;
  profileSummaries: Map<string, TimelineProfile>;
  reactionEvent?: NostrEvent;
  reactionTargetEvent?: NostrEvent;
  referenceById?: Map<string, TimelineItem>;
  referenceItems?: TimelineItem[];
}) {
  if (args.item.kind !== 7) {
    return args.item;
  }

  const referenceById = args.referenceById
    ?? new Map((args.referenceItems ?? []).map((item) => [item.id, item]));
  const notifyActorPubkey =
    args.item.notifyActorPubkey
    ?? normalizeNotifyPubkey(args.reactionEvent?.pubkey);
  const notifyReactionContent =
    args.item.notifyReactionContent
    ?? args.reactionEvent?.content
    ?? args.item.content;
  const notifyTargetEventId =
    args.item.notifyTargetEventId
    ?? args.reactionTargetEvent?.id
    ?? (args.reactionEvent ? findReactionTargetId(args.reactionEvent) : null)
    ?? null;
  const notifyActorProfile = notifyActorPubkey
    ? args.profileSummaries.get(notifyActorPubkey) ?? args.item.notifyActorProfile ?? null
    : null;
  const targetItem = notifyTargetEventId
    ? referenceById.get(notifyTargetEventId) ?? null
    : null;

  if (!targetItem) {
    const previousResolvedItem =
      args.previousItem?.notifyTargetEventId === notifyTargetEventId
      && args.previousItem.notifyActorPubkey === notifyActorPubkey
      && isResolvedNotifyTargetBody(args.previousItem)
        ? args.previousItem
        : null;

    if (previousResolvedItem) {
      return {
        ...previousResolvedItem,
        notifyActorPubkey,
        notifyActorProfile,
        notifyReactionContent,
        notifyTargetEventId,
        notifyTargetResolved: true,
      };
    }

    if (
      args.item.notifyActorPubkey === notifyActorPubkey
      && args.item.notifyReactionContent === notifyReactionContent
      && args.item.notifyTargetEventId === notifyTargetEventId
      && (args.item.notifyTargetResolved ?? false) === false
      && args.item.notifyActorProfile === notifyActorProfile
    ) {
      return args.item;
    }

    return {
      ...args.item,
      notifyActorPubkey,
      notifyActorProfile,
      notifyReactionContent,
      notifyTargetEventId,
      notifyTargetResolved: false,
    };
  }

  const latestTargetProfile = args.profileSummaries.get(targetItem.pubkey) ?? targetItem.profile;
  const latestReplyTargetProfile = targetItem.replyTargetPubkey
    ? args.profileSummaries.get(targetItem.replyTargetPubkey) ?? targetItem.replyTargetProfile
    : null;

  return {
    ...args.item,
    pubkey: targetItem.pubkey,
    content: targetItem.content,
    isReply: targetItem.isReply,
    replyTargetPubkey: targetItem.replyTargetPubkey,
    replyTargetProfile: latestReplyTargetProfile,
    replyContextPubkeys: targetItem.replyContextPubkeys,
    likeCount: targetItem.likeCount,
    profile: latestTargetProfile,
    notifyActorPubkey,
    notifyActorProfile,
    notifyReactionContent,
    notifyTargetEventId,
    notifyTargetResolved: true,
  };
}

function isResolvedNotifyTargetBody(item: TimelineItem) {
  return item.notifyTargetResolved ?? false;
}

function normalizeNotifyPubkey(pubkey: string | undefined) {
  if (!pubkey) {
    return null;
  }

  const normalized = pubkey.trim().toLowerCase();
  return normalized.length === 64 ? normalized : null;
}
