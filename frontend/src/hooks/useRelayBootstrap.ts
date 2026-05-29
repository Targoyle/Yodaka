import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { RelayDiagnosticState } from "../app/types";
import {
  loadCachedProfilesByPubkeys,
  persistProfileSummary,
  loadRelayStates,
  persistAcceptedEvent,
  replayCachedRelays,
  saveRelayState,
} from "../lib/nostr/cache";
import { extractProfileLookupPubkeysFromEvent } from "../lib/nostr/profileLookup";
import { normalizeHexPubkey } from "../lib/nostr/pubkey";
import { buildRoleAwareRelayStatus } from "../lib/nostr/relayStatusSummary";
import type { NostrEvent, RelayFilter } from "../lib/nostr/relay";
import {
  RelayCoordinator,
  type RelayCoordinatorStatus,
  type RelayPublishResult,
} from "../lib/nostr/relayCoordinator";
import type { RelaySetting } from "../lib/nostr/storage";
import {
  parseProfileSummary,
  profilesEqual,
  shouldReplaceProfileSummaryVersion,
  type ProfileSummaryVersion,
} from "../lib/nostr/profilePresentation";
import {
  buildDeferredRelayStatus,
  buildEmptyRelayDiagnostic,
  buildInitialRelayDiagnostics,
  buildInitialRelayStatus,
} from "../lib/ui/relayDisplay";
import {
  initializeWasm,
  listTimeline,
  resetTimeline,
  sinceHint,
  verifyAndInsert,
  verifyAndInsertRawJson,
  verifyProfileSummaryEventRawJson,
  type TimelineItem,
  type TimelineProfile,
} from "../lib/wasm/client";

const REACTION_TIMELINE_LIMIT = 200;
const SNAPSHOT_LIMIT = 200;
const TIMELINE_REFRESH_DELAY_MS = 120;
const PROFILE_BATCH_DELAY_MS = 400;
const PROFILE_REQUEST_RETRY_MS = 30_000;
const PROFILE_REQUEST_REFRESH_MS = 5 * 60_000;
const MAX_PENDING_PROFILE_LOOKUPS = 256;
const MAX_TRACKED_PROFILE_PUBKEYS = 4_096;
const MAX_FUTURE_SKEW_SEC = 600;

type UseRelayBootstrapArgs = {
  activeRelayUrls: string[];
  configuredRelayUrls: string[];
  readRelayUrls: string[];
  relayBootstrapDeferred: boolean;
  relayConfigurationKey: string;
  relaySettings: RelaySetting[];
  timelineLimit: number;
  writeRelayUrls: string[];
};

export function useRelayBootstrap(args: UseRelayBootstrapArgs) {
  const relayCoordinatorRef = useRef<RelayCoordinator | null>(null);
  const refreshSnapshotRef = useRef<() => Promise<TimelineItem[] | null>>(
    async () => null,
  );
  const scheduleRefreshRef = useRef<() => void>(() => {});
  const queueProfileLookupRef = useRef<(pubkey: string) => void>(() => {});
  const relaySettingsRef = useRef(args.relaySettings);
  const activeRelayUrlsRef = useRef(args.activeRelayUrls);
  const configuredRelayUrlsRef = useRef(args.configuredRelayUrls);
  const readRelayUrlsRef = useRef(args.readRelayUrls);
  const writeRelayUrlsRef = useRef(args.writeRelayUrls);
  const [relayStatus, setRelayStatus] = useState<RelayCoordinatorStatus>(() =>
    args.relayBootstrapDeferred
      ? buildDeferredRelayStatus(args.activeRelayUrls)
      : buildInitialRelayStatus(args.activeRelayUrls),
  );
  const [relayDiagnostics, setRelayDiagnostics] = useState<
    Record<string, RelayDiagnosticState>
  >(() => buildInitialRelayDiagnostics(args.relaySettings));
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const timelineRef = useRef(timeline);
  const profileSummariesRef = useRef<Map<string, TimelineProfile>>(new Map());
  const profileSummaryVersionsRef = useRef<Map<string, ProfileSummaryVersion>>(
    new Map(),
  );
  const [, setProfileSummaryVersion] = useState(0);
  const [syncStatus, setSyncStatus] = useState(() =>
    args.relayBootstrapDeferred
      ? "Key Miner 直開きのため relay 接続を保留"
      : "初期化待ち",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [overlayEventIds, setOverlayEventIds] = useState<string[]>([]);

  timelineRef.current = timeline;
  relaySettingsRef.current = args.relaySettings;
  activeRelayUrlsRef.current = args.activeRelayUrls;
  configuredRelayUrlsRef.current = args.configuredRelayUrls;
  readRelayUrlsRef.current = args.readRelayUrls;
  writeRelayUrlsRef.current = args.writeRelayUrls;

  const patchRelayDiagnostic = useCallback(
    (relayUrl: string, patch: Partial<RelayDiagnosticState>) => {
      setRelayDiagnostics((current) => ({
        ...current,
        [relayUrl]: {
          ...(current[relayUrl] ?? buildEmptyRelayDiagnostic()),
          ...patch,
        },
      }));
    },
    [],
  );

  const applyRelayPublishDiagnostics = useCallback(
    (result: RelayPublishResult) => {
      setRelayDiagnostics((current) => {
        const next = { ...current };

        for (const relayUrl of result.acceptedRelayUrls) {
          next[relayUrl] = {
            ...(next[relayUrl] ?? buildEmptyRelayDiagnostic()),
            lastPublishError: null,
          };
        }

        for (const error of result.errors) {
          next[error.relayUrl] = {
            ...(next[error.relayUrl] ?? buildEmptyRelayDiagnostic()),
            lastPublishError: error.message,
          };
        }

        return next;
      });

      if (
        result.errors.length > 0
        && import.meta.env.DEV
        && import.meta.env.MODE !== "test"
      ) {
        console.warn("[publish:relay_results]", {
          acceptedRelayUrls: result.acceptedRelayUrls,
          rejectedRelayUrls: result.rejectedRelayUrls,
          errors: result.errors,
        });
      }
    },
    [],
  );

  const countReadyWriteRelays = useCallback(() => {
    const writeRelayUrls = writeRelayUrlsRef.current;

    return relayStatus.relayStatuses.filter(
      (status) =>
        writeRelayUrls.includes(status.relayUrl) && status.phase === "live",
    ).length;
  }, [relayStatus]);

  const selectReactionRelayHint = useCallback(() => {
    const readRelayUrls = readRelayUrlsRef.current;
    const writeRelayUrls = writeRelayUrlsRef.current;

    return relayStatus.relayStatuses.find(
      (status) =>
        readRelayUrls.includes(status.relayUrl) && status.phase === "live",
    )?.relayUrl ?? readRelayUrls[0] ?? writeRelayUrls[0] ?? null;
  }, [relayStatus]);

  const ingestOverlayEvents = useCallback(async (events: NostrEvent[]) => {
    const insertedEventIds: string[] = [];

    for (const event of events) {
      let accepted = false;

      try {
        accepted = await verifyAndInsert({
          id: event.id,
          pubkey: event.pubkey,
          createdAt: event.created_at,
          kind: event.kind,
          tags: event.tags,
          content: event.content,
          sig: event.sig,
        });
      } catch {
        continue;
      }

      if (!accepted) {
        continue;
      }

      insertedEventIds.push(event.id);
      for (const pubkey of extractProfileLookupPubkeysFromEvent(event)) {
        queueProfileLookupRef.current(pubkey);
      }
    }

    if (insertedEventIds.length > 0) {
      setOverlayEventIds((current) => [
        ...new Set([...current, ...insertedEventIds]),
      ]);
      return refreshSnapshotRef.current();
    }

    return null;
  }, []);

  useEffect(() => {
    setRelayDiagnostics((current) => {
      const next = Object.fromEntries(
        args.relaySettings.map((setting) => [
          setting.url,
          current[setting.url] ?? buildEmptyRelayDiagnostic(),
        ]),
      ) as Record<string, RelayDiagnosticState>;

      return next;
    });
  }, [args.relaySettings]);

  useEffect(() => {
    if (!args.relayBootstrapDeferred) {
      return;
    }

    setErrorMessage(null);
    setSyncStatus("Key Miner 直開きのため relay 接続を保留");
    setRelayStatus(buildDeferredRelayStatus(activeRelayUrlsRef.current));
  }, [args.relayBootstrapDeferred, args.relayConfigurationKey]);

  useEffect(() => {
    if (args.relayBootstrapDeferred) {
      return;
    }

    let cancelled = false;
    let coordinator: RelayCoordinator | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let profileBatchTimer: ReturnType<typeof setTimeout> | null = null;
    let readyRelayCount = 0;
    let sinceBufferSec = 15;
    let persistenceQueue = Promise.resolve();
    const persistedRelaySinceHints = new Map<string, number | null>();
    const persistedRelayLastConnecteds = new Map<string, number>();
    const pendingRelayLastConnecteds = new Map<string, number>();
    const relaySafeFeedCreatedAts = new Map<string, number>();
    const requestedProfilePubkeys = new Map<
      string,
      {
        generation: number;
        requestedAt: number;
      }
    >();
    const pendingProfilePubkeys = new Set<string>();
    let profileRequestGeneration = 0;
    const activeRelayUrls = activeRelayUrlsRef.current;
    const configuredRelayUrls = configuredRelayUrlsRef.current;
    const readRelayUrls = readRelayUrlsRef.current;
    const writeRelayUrls = writeRelayUrlsRef.current;

    function getRelaySettingPosition(relayUrl: string) {
      const index = relaySettingsRef.current.findIndex(
        (setting) => setting.url === relayUrl,
      );

      return index >= 0 ? index : relaySettingsRef.current.length;
    }

    function clearRefreshTimer() {
      if (!refreshTimer) {
        return;
      }

      clearTimeout(refreshTimer);
      refreshTimer = null;
    }

    function clearProfileBatchTimer() {
      if (!profileBatchTimer) {
        return;
      }

      clearTimeout(profileBatchTimer);
      profileBatchTimer = null;
    }

    function scheduleProfileBatchFlush() {
      if (
        profileBatchTimer
        || readyRelayCount === 0
        || pendingProfilePubkeys.size === 0
      ) {
        return;
      }

      profileBatchTimer = setTimeout(() => {
        void flushPendingProfiles();
      }, PROFILE_BATCH_DELAY_MS);
    }

    function nextProfileRequestGeneration() {
      profileRequestGeneration += 1;
    }

    function updateSnapshot(items: TimelineItem[]) {
      startTransition(() => {
        setTimeline(items);
      });
    }

    function mergeProfileSummary(args: {
      pubkey: string;
      profile: TimelineProfile | null;
      version: ProfileSummaryVersion;
    }) {
      const normalizedPubkey = normalizeHexPubkey(args.pubkey);
      const currentVersion =
        profileSummaryVersionsRef.current.get(normalizedPubkey) ?? null;

      if (!shouldReplaceProfileSummaryVersion(currentVersion, args.version)) {
        return false;
      }

      profileSummaryVersionsRef.current.set(normalizedPubkey, args.version);

      const currentProfile =
        profileSummariesRef.current.get(normalizedPubkey) ?? null;

      if (profilesEqual(currentProfile, args.profile)) {
        return false;
      }

      if (args.profile) {
        profileSummariesRef.current.set(normalizedPubkey, args.profile);
      } else {
        profileSummariesRef.current.delete(normalizedPubkey);
      }

      return true;
    }

    function mergeKnownProfilesFromTimeline(items: TimelineItem[]) {
      let changed = false;

      for (const item of items) {
        if (!item.profile) {
          continue;
        }

        const normalizedPubkey = normalizeHexPubkey(item.pubkey);
        const currentVersion =
          profileSummaryVersionsRef.current.get(normalizedPubkey) ?? null;

        if (currentVersion) {
          continue;
        }

        changed = mergeProfileSummary({
          pubkey: normalizedPubkey,
          profile: item.profile,
          version: {
            createdAt: 0,
            eventId: null,
          },
        }) || changed;
      }

      if (changed) {
        setProfileSummaryVersion((current) => current + 1);
      }
    }

    function collectProfileLookupPubkeys(items: TimelineItem[]) {
      return items.flatMap((item) => [
        item.pubkey,
        ...item.replyContextPubkeys,
        ...(item.replyTargetPubkey ? [item.replyTargetPubkey] : []),
      ]);
    }

    async function hydrateCachedProfiles(pubkeys: string[]) {
      const records = await loadCachedProfilesByPubkeys(pubkeys);

      if (cancelled || records.length === 0) {
        return;
      }

      let changed = false;

      for (const record of records) {
        const profile =
          record.summary
          ?? parseProfileSummary(record.rawContent ?? "");

        changed = mergeProfileSummary({
          pubkey: record.pubkey,
          profile,
          version: {
            createdAt: record.createdAt,
            eventId: record.eventId,
          },
        }) || changed;
      }

      if (changed) {
        setProfileSummaryVersion((current) => current + 1);
      }
    }

    function shouldRequestProfile(pubkey: string) {
      const trimmedPubkey = pubkey.trim();

      if (trimmedPubkey === "") {
        return false;
      }

      const lastRequested = requestedProfilePubkeys.get(trimmedPubkey);

      if (!lastRequested) {
        return true;
      }

      if (lastRequested.generation < profileRequestGeneration) {
        return true;
      }

      const cooldownMs = profileSummariesRef.current.has(trimmedPubkey)
        ? PROFILE_REQUEST_REFRESH_MS
        : PROFILE_REQUEST_RETRY_MS;

      return Date.now() - lastRequested.requestedAt >= cooldownMs;
    }

    async function refreshSnapshot() {
      const items = await listTimeline(SNAPSHOT_LIMIT, null);

      if (cancelled) {
        return null;
      }

      mergeKnownProfilesFromTimeline(items);
      updateSnapshot(items);
      return items;
    }

    function reportCacheWarning(scope: string, error: unknown) {
      if (!import.meta.env.DEV) {
        return;
      }

      console.warn(`[cache:${scope}]`, error);
    }

    function logCacheReplay(replayedFeedEvents: number, replayedProfiles: number) {
      if (!import.meta.env.DEV || import.meta.env.MODE === "test") {
        return;
      }

      console.info("[cache:replay]", {
        relayUrls: readRelayUrls,
        replayedFeedEvents,
        replayedProfiles,
      });
    }

    function applyRelayRecordDiagnostics(
      relayUrl: string,
      record: {
        sinceHint: number | null;
        lastConnected: number;
      } | null,
    ) {
      patchRelayDiagnostic(relayUrl, {
        sinceHint: record?.sinceHint ?? null,
        lastConnected: record?.lastConnected ?? 0,
      });
    }

    function initializeRelayState(
      relayUrl: string,
      record: {
        sinceHint: number | null;
        lastConnected: number;
      } | null,
    ) {
      const sinceValue = record?.sinceHint ?? null;
      persistedRelaySinceHints.set(relayUrl, sinceValue);
      persistedRelayLastConnecteds.set(relayUrl, record?.lastConnected ?? 0);
      applyRelayRecordDiagnostics(relayUrl, record);

      if (sinceValue === null) {
        return;
      }

      relaySafeFeedCreatedAts.set(relayUrl, sinceValue + sinceBufferSec);
    }

    function updateRelayCursor(relayUrl: string, createdAt: number) {
      const now = Math.floor(Date.now() / 1000);
      const safeCreatedAt = Math.min(createdAt, now + MAX_FUTURE_SKEW_SEC);
      const current = relaySafeFeedCreatedAts.get(relayUrl) ?? 0;

      if (safeCreatedAt > current) {
        relaySafeFeedCreatedAts.set(relayUrl, safeCreatedAt);
      }
    }

    function getRelaySinceHint(relayUrl: string) {
      const safeCreatedAt = relaySafeFeedCreatedAts.get(relayUrl);

      if (typeof safeCreatedAt === "number") {
        return Math.max(0, safeCreatedAt - sinceBufferSec);
      }

      return persistedRelaySinceHints.get(relayUrl) ?? null;
    }

    async function persistRelayStateFor(
      relayUrl: string,
      options?: {
        lastConnectedAt?: number;
      },
    ) {
      const nextSinceHint = getRelaySinceHint(relayUrl);
      const nextLastConnected =
        options?.lastConnectedAt
        ?? persistedRelayLastConnecteds.get(relayUrl)
        ?? 0;
      const relaySetting = relaySettingsRef.current.find(
        (setting) => setting.url === relayUrl,
      );

      persistedRelaySinceHints.set(relayUrl, nextSinceHint);
      persistedRelayLastConnecteds.set(relayUrl, nextLastConnected);
      applyRelayRecordDiagnostics(relayUrl, {
        sinceHint: nextSinceHint,
        lastConnected: nextLastConnected,
      });

      await saveRelayState({
        url: relayUrl,
        sinceHint: nextSinceHint,
        lastConnected: nextLastConnected,
        enabled: relaySetting?.enabled ?? true,
        read: relaySetting?.read ?? true,
        write: relaySetting?.write ?? true,
        nip65Managed: relaySetting?.nip65Managed ?? false,
        position: getRelaySettingPosition(relayUrl),
      });
    }

    function recordRelayDebugEvent(args: {
      relayUrl: string;
      type: "notice" | "closed" | "error";
      message: string | null;
    }) {
      if (cancelled || !args.message) {
        return;
      }

      switch (args.type) {
        case "notice":
          patchRelayDiagnostic(args.relayUrl, {
            lastNotice: args.message,
          });
          return;

        case "closed":
          patchRelayDiagnostic(args.relayUrl, {
            lastClosedMessage: args.message,
          });
          return;

        case "error":
          patchRelayDiagnostic(args.relayUrl, {
            lastError: args.message,
          });
      }
    }

    function enqueuePersistence(task: () => Promise<void>) {
      persistenceQueue = persistenceQueue.then(async () => {
        if (cancelled) {
          return;
        }

        try {
          await task();
        } catch (error) {
          reportCacheWarning("persist", error);
        }
      });

      return persistenceQueue;
    }

    function scheduleRefresh() {
      if (refreshTimer) {
        return;
      }

      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refreshSnapshot();
      }, TIMELINE_REFRESH_DELAY_MS);
    }

    function requestProfiles(pubkeys: string[]) {
      const authors = [
        ...new Set(pubkeys.map((pubkey) => pubkey.trim()).filter(Boolean)),
      ].filter((pubkey) => shouldRequestProfile(pubkey));

      if (authors.length === 0) {
        return {
          accepted: false,
          authors,
        };
      }

      if (!coordinator || coordinator.requestProfiles(authors) === 0) {
        return {
          accepted: false,
          authors,
        };
      }

      const requestedAt = Date.now();

      for (const author of authors) {
        requestedProfilePubkeys.set(author, {
          generation: profileRequestGeneration,
          requestedAt,
        });
      }

      trimTrackedPubkeys(requestedProfilePubkeys);

      return {
        accepted: true,
        authors,
      };
    }

    async function flushPendingProfiles() {
      profileBatchTimer = null;

      if (pendingProfilePubkeys.size === 0) {
        return;
      }

      const pubkeys = [...pendingProfilePubkeys];
      pendingProfilePubkeys.clear();
      await hydrateCachedProfiles(pubkeys);
      const result = requestProfiles(pubkeys);

      if (!result.accepted && result.authors.length > 0) {
        for (const pubkey of result.authors) {
          if (pendingProfilePubkeys.size >= MAX_PENDING_PROFILE_LOOKUPS) {
            break;
          }

          pendingProfilePubkeys.add(pubkey);
        }
      }

      scheduleProfileBatchFlush();
    }

    function queueProfileLookup(pubkey: string) {
      const normalizedPubkey = normalizeHexPubkey(pubkey);

      if (
        pendingProfilePubkeys.has(normalizedPubkey) ||
        !shouldRequestProfile(normalizedPubkey)
      ) {
        return;
      }

      if (pendingProfilePubkeys.size >= MAX_PENDING_PROFILE_LOOKUPS) {
        return;
      }

      pendingProfilePubkeys.add(normalizedPubkey);
      scheduleProfileBatchFlush();
    }

    function queueProfileLookups(pubkeys: string[]) {
      for (const pubkey of pubkeys) {
        queueProfileLookup(pubkey);
      }
    }

    function applyRelayStatus(status: RelayCoordinatorStatus) {
      const roleAwareStatus = buildRoleAwareRelayStatus({
        readRelayUrls: readRelayUrlsRef.current,
        status,
        writeRelayUrls: writeRelayUrlsRef.current,
      });

      if (roleAwareStatus.readyRelayCount > readyRelayCount) {
        nextProfileRequestGeneration();
      }

      readyRelayCount = roleAwareStatus.readyRelayCount;
      scheduleProfileBatchFlush();

      if (cancelled) {
        return;
      }

      setRelayStatus(roleAwareStatus);

      switch (roleAwareStatus.phase) {
        case "connecting":
          clearProfileBatchTimer();
          requestedProfilePubkeys.clear();
          nextProfileRequestGeneration();
          setSyncStatus("relay connecting");
          setErrorMessage(null);
          return;

        case "subscribing":
          setSyncStatus("Feed syncing");
          return;

        case "partial":
          setSyncStatus("some read relays live");
          return;

        case "live":
          setSyncStatus("all read relays live");
          return;

        case "degraded":
          setSyncStatus("some read relays reconnecting");
          return;

        case "offline":
          clearProfileBatchTimer();
          setSyncStatus("live relay がありません");
          return;

        case "closed":
          setSyncStatus("subscription closed");
          return;

        case "idle":
          setSyncStatus("IDLE");
      }
    }

    async function bootstrap() {
      setErrorMessage(null);
      setOverlayEventIds([]);
      setSyncStatus("WASM 初期化中");
      setRelayStatus(buildInitialRelayStatus(activeRelayUrls));

      const storedRelayStates = await loadRelayStates(configuredRelayUrls);

      if (cancelled) {
        return;
      }

      for (const relayUrl of configuredRelayUrls) {
        applyRelayRecordDiagnostics(relayUrl, storedRelayStates[relayUrl] ?? null);
      }

      if (activeRelayUrls.length === 0) {
        setErrorMessage("有効 relay が設定されていません");
        setSyncStatus("有効 relay 未設定");
        return;
      }

      try {
        await initializeWasm();
        const hintValue = await sinceHint();
        sinceBufferSec = hintValue.bufferSec;
        resetTimeline();
        setSyncStatus("キャッシュ復元中");
        const replay = await replayCachedRelays({
          relayUrls: readRelayUrls,
          insertEventJson: verifyAndInsertRawJson,
        });

        for (const relayUrl of activeRelayUrls) {
          initializeRelayState(
            relayUrl,
            storedRelayStates[relayUrl] ?? replay.relayRecords[relayUrl] ?? null,
          );
        }

        logCacheReplay(replay.replayedFeedEvents, replay.replayedProfiles);
        const replayedItems = await refreshSnapshot();

        if (replayedItems) {
          await hydrateCachedProfiles(collectProfileLookupPubkeys(replayedItems));
        }

        if (cancelled) {
          return;
        }

        const replayedCount = replay.replayedFeedEvents + replay.replayedProfiles;
        setSyncStatus(
          replayedCount > 0
            ? `キャッシュ ${replayedCount}件 を復元`
            : "キャッシュなし",
        );

        coordinator = new RelayCoordinator({
          relayUrls: activeRelayUrls,
          profileRelayUrls: readRelayUrls,
          publishRelayUrls: writeRelayUrls,
          buildFeedFilters: async (relayUrl) => {
            if (!readRelayUrls.includes(relayUrl)) {
              return [];
            }

            const noteFilter: RelayFilter = {
              kinds: [1],
              limit: args.timelineLimit,
            };
            const reactionFilter: RelayFilter = {
              kinds: [7],
              limit: REACTION_TIMELINE_LIMIT,
            };
            const sinceValue = getRelaySinceHint(relayUrl);

            if (sinceValue !== null) {
              noteFilter.since = sinceValue;
              reactionFilter.since = sinceValue;
            }

            return [noteFilter, reactionFilter];
          },
          onStatus: applyRelayStatus,
          onRelayStatus: (status) => {
            const statusAt = Date.now();

            if (cancelled) {
              return;
            }

            patchRelayDiagnostic(status.relayUrl, {
              lastStatusAt: statusAt,
              ...(status.phase === "live"
                ? {
                    lastConnected: statusAt,
                  }
                : {}),
            });

            if (status.phase === "live") {
              pendingRelayLastConnecteds.set(status.relayUrl, statusAt);
              return;
            }

            if (status.phase !== "reconnecting" && status.phase !== "closed") {
              return;
            }

            void enqueuePersistence(() => persistRelayStateFor(status.relayUrl));
          },
          onDebug: (event) => {
            switch (event.type) {
              case "recv_notice":
                recordRelayDebugEvent({
                  relayUrl: event.relayUrl,
                  type: "notice",
                  message: event.detail ?? "relay から NOTICE を受信しました",
                });
                return;

              case "recv_closed":
              case "socket_close":
                recordRelayDebugEvent({
                  relayUrl: event.relayUrl,
                  type: "closed",
                  message: event.detail ?? "relay が close しました",
                });
                return;

              case "socket_error":
              case "drop_message":
                recordRelayDebugEvent({
                  relayUrl: event.relayUrl,
                  type: "error",
                  message: event.detail ?? "relay でエラーが発生しました",
                });
            }
          },
          onEvent: async ({ relayUrl, role, event }) => {
            if (role === "profiles" && event.kind === 0) {
              let verifiedProfile = null;

              try {
                verifiedProfile = await verifyProfileSummaryEventRawJson(
                  JSON.stringify(event),
                );
              } catch (error) {
                if (!cancelled) {
                  const message =
                    error instanceof Error ? error.message : String(error);
                  setErrorMessage(`profile 検証に失敗しました: ${message}`);
                }
                return;
              }

              if (cancelled || !verifiedProfile) {
                return;
              }

              if (
                mergeProfileSummary({
                  pubkey: verifiedProfile.pubkey,
                  profile: verifiedProfile.profile,
                  version: {
                    createdAt: verifiedProfile.createdAt,
                    eventId: verifiedProfile.eventId,
                  },
                })
              ) {
                setProfileSummaryVersion((currentVersion) => currentVersion + 1);
              }

              void enqueuePersistence(() =>
                persistProfileSummary({
                  pubkey: verifiedProfile.pubkey,
                  eventId: verifiedProfile.eventId,
                  createdAt: verifiedProfile.createdAt,
                  profile: verifiedProfile.profile,
                }),
              );
              return;
            }

            let accepted = false;

            try {
              accepted = await verifyAndInsert({
                id: event.id,
                pubkey: event.pubkey,
                createdAt: event.created_at,
                kind: event.kind,
                tags: event.tags,
                content: event.content,
                sig: event.sig,
              });
            } catch (error) {
              if (!cancelled) {
                const message =
                  error instanceof Error ? error.message : String(error);
                setErrorMessage(`event 検証に失敗しました: ${message}`);
              }
              return;
            }

            if (role === "feed") {
              updateRelayCursor(relayUrl, event.created_at);
              setOverlayEventIds((current) =>
                current.includes(event.id)
                  ? current.filter((eventId) => eventId !== event.id)
                  : current,
              );
            }

            if (cancelled) {
              return;
            }

            if (accepted) {
              void enqueuePersistence(() =>
                persistAcceptedEvent({
                  relayUrl,
                  event,
                }),
              );
            }

            if (accepted && event.kind === 0) {
              if (
                mergeProfileSummary({
                  pubkey: event.pubkey,
                  profile: parseProfileSummary(event.content),
                  version: {
                    createdAt: event.created_at,
                    eventId: event.id,
                  },
                })
              ) {
                setProfileSummaryVersion((currentVersion) => currentVersion + 1);
              }
            }

            if (role === "feed") {
              scheduleRefresh();
              queueProfileLookups(extractProfileLookupPubkeysFromEvent(event));
              return;
            }

            if (accepted) {
              scheduleRefresh();
            }
          },
          onEose: async ({ relayUrl, role }) => {
            if (cancelled || role !== "feed") {
              return;
            }

            const items = await refreshSnapshot();

            if (!items) {
              return;
            }

            const profilePubkeys = collectProfileLookupPubkeys(items);
            await hydrateCachedProfiles(profilePubkeys);
            queueProfileLookups(profilePubkeys);

            try {
              await persistenceQueue;

              if (cancelled) {
                return;
              }

              const lastConnectedAt =
                pendingRelayLastConnecteds.get(relayUrl) ?? Date.now();
              pendingRelayLastConnecteds.delete(relayUrl);
              await persistRelayStateFor(relayUrl, {
                lastConnectedAt,
              });
            } catch (error) {
              reportCacheWarning("relay-state", error);
            }
          },
          onClosed: () => {},
          onError: () => {},
        });

        coordinator.connect();
        relayCoordinatorRef.current = coordinator;
        setSyncStatus(`${activeRelayUrls.length} relay へ接続開始`);
      } catch (error) {
        if (cancelled) {
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        setErrorMessage(message);
        setSyncStatus("初期化失敗");
      }
    }

    refreshSnapshotRef.current = refreshSnapshot;
    scheduleRefreshRef.current = scheduleRefresh;
    queueProfileLookupRef.current = queueProfileLookup;
    void bootstrap();

    return () => {
      cancelled = true;
      clearRefreshTimer();
      clearProfileBatchTimer();
      relayCoordinatorRef.current = null;
      refreshSnapshotRef.current = async () => null;
      scheduleRefreshRef.current = () => {};
      queueProfileLookupRef.current = () => {};
      coordinator?.close();
    };
  }, [
    args.relayBootstrapDeferred,
    args.relayConfigurationKey,
    args.timelineLimit,
    patchRelayDiagnostic,
  ]);

  return {
    applyRelayPublishDiagnostics,
    countReadyWriteRelays,
    errorMessage,
    ingestOverlayEvents,
    overlayEventIds,
    profileSummariesRef,
    queueProfileLookupRef,
    refreshSnapshotRef,
    relayCoordinatorRef,
    relayDiagnostics,
    relayStatus,
    scheduleRefreshRef,
    selectReactionRelayHint,
    syncStatus,
    timeline,
    timelineRef,
  };
}

function trimTrackedPubkeys(
  pubkeys: Map<
    string,
    {
      generation: number;
      requestedAt: number;
    }
  >,
) {
  while (pubkeys.size > MAX_TRACKED_PROFILE_PUBKEYS) {
    const oldest = pubkeys.values().next().value;
    const oldestPubkey = pubkeys.keys().next().value;

    if (
      typeof oldestPubkey !== "string"
      || oldest == null
    ) {
      return;
    }

    pubkeys.delete(oldestPubkey);
  }
}
