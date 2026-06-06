import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MutableRefObject,
} from "react";
import type { TimelineView } from "../app/types";
import { normalizeRelayUrls } from "../lib/nostr/contacts";
import {
  type FocusedEventRoute,
  resolveFocusedEventRouteFromLocation,
  stripFocusedEventFromLocation,
} from "../lib/nostr/eventRoute";
import {
  buildEventLookupRelayUrls,
  fetchLatestEventByIdViaAuthorRelays,
} from "../lib/nostr/eventDebug";
import { buildStandaloneTimelineItem } from "../lib/nostr/timelineItem";
import { buildAuxiliaryTimeline } from "../lib/nostr/timelinePresentation";
import type { RelayOneShotTransport } from "../lib/nostr/contacts";
import type { TimelineItem, TimelineProfile } from "../lib/wasm/client";

type FocusedEventFetchState = "idle" | "loading" | "ready" | "error";

type UseFocusedEventRouteArgs = {
  initialFocusedEventRoute: FocusedEventRoute | null;
  profileSummariesRef: MutableRefObject<Map<string, TimelineProfile>>;
  queueProfileLookupRef: MutableRefObject<(pubkey: string) => void>;
  readRelayUrls: string[];
  referenceItems: TimelineItem[];
  referenceItemsById: Map<string, TimelineItem>;
  timelineView: TimelineView;
  transport: RelayOneShotTransport;
  onEnterFocusedRelayView: () => void;
};

export function useFocusedEventRoute(args: UseFocusedEventRouteArgs) {
  const {
    initialFocusedEventRoute,
    onEnterFocusedRelayView,
    profileSummariesRef,
    queueProfileLookupRef,
    readRelayUrls,
    referenceItems,
    referenceItemsById,
    timelineView,
    transport,
  } = args;
  const [focusedEventRoute, setFocusedEventRoute] = useState(initialFocusedEventRoute);
  const [focusedEventItem, setFocusedEventItem] = useState<TimelineItem | null>(null);
  const [focusedEventFetchState, setFocusedEventFetchState] = useState<
    FocusedEventFetchState
  >(() => (initialFocusedEventRoute ? "loading" : "idle"));
  const [focusedEventFetchError, setFocusedEventFetchError] = useState<string | null>(null);

  const focusedEventDisplayItem = useMemo(
    () => (
      focusedEventRoute
        ? referenceItemsById.get(focusedEventRoute.eventId) ?? focusedEventItem
        : null
    ),
    [focusedEventItem, focusedEventRoute, referenceItemsById],
  );

  const clearFocusedEventRoute = useCallback(() => {
    const nextUrl = stripFocusedEventFromLocation();

    if (typeof window !== "undefined" && nextUrl) {
      window.history.replaceState(null, "", nextUrl);
    }

    setFocusedEventRoute(null);
    setFocusedEventItem(null);
    setFocusedEventFetchError(null);
    setFocusedEventFetchState("idle");
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handlePopState = () => {
      const nextRoute = resolveFocusedEventRouteFromLocation();

      setFocusedEventRoute(nextRoute);
      setFocusedEventItem(null);
      setFocusedEventFetchError(null);
      setFocusedEventFetchState(nextRoute ? "loading" : "idle");

      if (nextRoute) {
        onEnterFocusedRelayView();
      }
    };

    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [onEnterFocusedRelayView]);

  useEffect(() => {
    if (!focusedEventRoute || timelineView === "relay") {
      return;
    }

    onEnterFocusedRelayView();
  }, [focusedEventRoute, onEnterFocusedRelayView, timelineView]);

  useEffect(() => {
    if (!focusedEventDisplayItem) {
      return;
    }

    queueProfileLookupRef.current(focusedEventDisplayItem.pubkey);

    if (focusedEventDisplayItem.replyTargetPubkey) {
      queueProfileLookupRef.current(focusedEventDisplayItem.replyTargetPubkey);
    }
  }, [focusedEventDisplayItem, queueProfileLookupRef]);

  useEffect(() => {
    if (!focusedEventRoute) {
      setFocusedEventItem(null);
      setFocusedEventFetchError(null);
      setFocusedEventFetchState("idle");
      return;
    }

    const existingItem = referenceItemsById.get(focusedEventRoute.eventId);

    if (existingItem) {
      setFocusedEventItem(existingItem);
      setFocusedEventFetchError(null);
      setFocusedEventFetchState("ready");
      return;
    }

    const baseRelayUrls = buildEventLookupRelayUrls(
      readRelayUrls,
      focusedEventRoute.relayUrls,
    );

    if (baseRelayUrls.length === 0) {
      setFocusedEventFetchState("loading");
      return;
    }

    let cancelled = false;

    setFocusedEventFetchError(null);
    setFocusedEventFetchState("loading");

    void (async () => {
      try {
        const event = await fetchLatestEventByIdViaAuthorRelays({
          authorPubkey: focusedEventRoute.authorPubkey,
          baseRelayUrls,
          eventId: focusedEventRoute.eventId,
          relayListLookupRelayUrls:
            readRelayUrls.length > 0
              ? normalizeRelayUrls(readRelayUrls)
              : baseRelayUrls,
          transport,
          options: { allowDirectFallback: true },
        });

        if (cancelled) {
          return;
        }

        if (!event) {
          setFocusedEventItem(null);
          setFocusedEventFetchError("ポストを取得できませんでした");
          setFocusedEventFetchState("error");
          return;
        }

        const nextItem =
          buildAuxiliaryTimeline({
            events: [event],
            profileSummaries: profileSummariesRef.current,
            referenceItems,
            timelineLimit: 1,
          })[0]
          ?? buildStandaloneTimelineItem(
            event,
            profileSummariesRef.current.get(event.pubkey) ?? null,
          );

        setFocusedEventItem(nextItem);
        setFocusedEventFetchError(null);
        setFocusedEventFetchState("ready");
      } catch (error) {
        if (cancelled) {
          return;
        }

        const message = error instanceof Error ? error.message : String(error);

        setFocusedEventItem(null);
        setFocusedEventFetchError(`ポストの取得に失敗しました: ${message}`);
        setFocusedEventFetchState("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    focusedEventRoute,
    profileSummariesRef,
    readRelayUrls,
    referenceItems,
    referenceItemsById,
    transport,
  ]);

  return {
    clearFocusedEventRoute,
    focusedEventDisplayItem,
    focusedEventFetchError,
    focusedEventFetchState,
    focusedEventRoute,
  };
}
