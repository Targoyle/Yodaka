import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import type { TimelineView } from "./types";
import {
  clearCacheDatabase,
  saveRelaySettingsSnapshot,
} from "../lib/nostr/cache";
import { normalizeRelayUrls } from "../lib/nostr/contacts";
import { encodeNevent } from "../lib/nostr/nip19";
import { resolveFocusedEventRouteFromLocation } from "../lib/nostr/eventRoute";
import {
  formatReactionContentLabel,
  type ReactionIntent,
} from "../lib/nostr/reaction";
import {
  buildFocusedThreadTimeline,
  buildTimelineEmptyMessage,
  buildVisibleTimeline,
} from "../lib/nostr/timelinePresentation";
import { moveRelaySettings } from "../lib/nostr/relaySettings";
import {
  loadAccountTabEnabled,
  buildDefaultRelaySettings,
  clearAppStorage,
  listActiveRelayUrls,
  listReadRelayUrls,
  listWriteRelayUrls,
  loadDeveloperModeEnabled,
  loadManualPubkey,
  loadNotifyTabEnabled,
  loadProfileImagesEnabled,
  loadReactionTabEnabled,
  loadRelaySettings,
  loadThemePreference,
  saveAccountTabEnabled,
  saveDeveloperModeEnabled,
  saveProfileImagesEnabled,
  saveNotifyTabEnabled,
  saveReactionTabEnabled,
  saveRelaySettings,
  saveThemePreference,
  type RelaySetting,
  type ThemePreference,
} from "../lib/nostr/storage";
import {
  buildRelayButtonTitle,
} from "../lib/ui/relayDisplay";
import { pickComposerWelcomeMessage } from "../lib/ui/composerMessages";
import { ComposerPanel } from "../components/ComposerPanel";
import { ManualPubkeyDialog } from "../components/ManualPubkeyDialog";
import { TimelinePanel } from "../components/TimelinePanel";
import { AppToolbar } from "../components/AppToolbar";
import { useManualPubkeyDialog } from "../hooks/useManualPubkeyDialog";
import { useSignerPubkey } from "../hooks/useSignerPubkey";
import { useFollowTimeline } from "../hooks/useFollowTimeline";
import { useAccountTimeline } from "../hooks/useAccountTimeline";
import { useNotifyTimeline } from "../hooks/useNotifyTimeline";
import { useReactionTimeline } from "../hooks/useReactionTimeline";
import { usePublish } from "../hooks/usePublish";
import { useRelayBootstrap } from "../hooks/useRelayBootstrap";
import { useKeyMinerPanel } from "../hooks/useKeyMinerPanel";
import { useContentEventPreviewCache } from "../hooks/useContentEventPreviewCache";
import { useReplyPreviewCache } from "../hooks/useReplyPreviewCache";
import { useFocusedEventRoute } from "../hooks/useFocusedEventRoute";
import { loginWithNsec } from "../lib/wasm/client";
import { createTemporaryRelayTransport } from "../lib/nostr/temporaryRelayTransport";
import { fetchLatestEventByIdAcrossRelays, formatDebugEventJson } from "../lib/nostr/eventDebug";
import type { TimelineItem } from "../lib/wasm/client";

const TIMELINE_LIMIT = 50;

const loadKeyMinerPanel = () =>
  import("../components/KeyMinerPanel").then((module) => ({
    default: module.KeyMinerPanel,
  }));
const loadSignerDialog = () =>
  import("../components/SignerDialog").then((module) => ({
    default: module.SignerDialog,
  }));
const loadEventJsonDialog = () =>
  import("../components/EventJsonDialog").then((module) => ({
    default: module.EventJsonDialog,
  }));

const LazyKeyMinerPanel = lazy(loadKeyMinerPanel);
const LazySignerDialog = lazy(loadSignerDialog);
const LazyEventJsonDialog = lazy(loadEventJsonDialog);
const COMPOSER_NOTIFY_TTL_MS = 5_000;
type PendingAuthenticatedTimelineAction =
  | {
      item: TimelineItem;
      reactionIntent: ReactionIntent;
      type: "reaction";
    }
  | {
      item: TimelineItem;
      type: "repost";
    };

export function App() {
  const [relaySettings, setRelaySettings] = useState<RelaySetting[]>(() =>
    loadRelaySettings(),
  );
  const [profileImagesEnabled, setProfileImagesEnabled] = useState(() =>
    loadProfileImagesEnabled(),
  );
  const [developerModeEnabled, setDeveloperModeEnabled] = useState(() =>
    loadDeveloperModeEnabled(),
  );
  const [physicsEnabled, setPhysicsEnabled] = useState(false);
  const [accountTabEnabled, setAccountTabEnabled] = useState(() =>
    loadAccountTabEnabled(),
  );
  const [notifyTabEnabled, setNotifyTabEnabled] = useState(() =>
    loadNotifyTabEnabled(),
  );
  const [reactionTabEnabled, setReactionTabEnabled] = useState(() =>
    loadReactionTabEnabled(),
  );
  const [composerWelcomeDismissed, setComposerWelcomeDismissed] = useState(false);
  const [composerNotifyQueue, setComposerNotifyQueue] = useState<Array<{
    id: string;
    text: string;
  }>>([]);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const settingsMenuRef = useRef<HTMLDetailsElement | null>(null);
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    loadThemePreference(),
  );
  const {
    handleKeyMinerToggle,
    keyMinerLaunchConfig,
    keyMinerOpen,
    relayBootstrapDeferred,
  } = useKeyMinerPanel({
    settingsMenuRef,
  });
  const initialManualPubkey = useRef(loadManualPubkey()).current;
  const initialFocusedEventRoute = useRef(resolveFocusedEventRouteFromLocation()).current;
  const {
    activeSignerKind,
    adoptNip07SignerPubkey,
    autoSignerPromptBlocked,
    clearActiveSigner,
    clearSignerRequestFeedback,
    createActiveSigner,
    ensureSignerPubkey,
    ensureViewerPubkey,
    isResolvingSignerPubkey,
    markSignerUnavailable,
    refreshLocalSignerSession,
    requestNip07PubkeyFromUserGesture,
    requestSignerPubkeyFromUserGesture,
    setAutoSignerPromptBlocked,
    signerAvailable,
    signerPubkey,
    signerRequestError,
    signerRequestMessage,
  } = useSignerPubkey();
  const [relayDraftUrl, setRelayDraftUrl] = useState("");
  const [relaySettingsError, setRelaySettingsError] = useState<string | null>(null);
  const [signerDialogOpen, setSignerDialogOpen] = useState(false);
  const [pendingFollowAfterNsecLogin, setPendingFollowAfterNsecLogin] = useState(false);
  const [pendingAuthenticatedTimelineAction, setPendingAuthenticatedTimelineAction] =
    useState<PendingAuthenticatedTimelineAction | null>(null);
  const [composerWelcomeMessage, setComposerWelcomeMessage] = useState<string | null>(null);
  const [eventJsonDialogState, setEventJsonDialogState] = useState<{
    isOpen: boolean;
    title: string;
    jsonText: string;
  }>({
    isOpen: false,
    title: "",
    jsonText: "",
  });
  const [timelineView, setTimelineView] = useState<TimelineView>(() =>
    initialFocusedEventRoute ? "relay" : initialManualPubkey ? "follow" : "relay",
  );
  const {
    closeManualPubkeyDialog,
    handleManualPubkeyClear,
    handleManualPubkeyDraftChange,
    handleManualPubkeyPaste,
    handleManualPubkeySubmit,
    isPastingManualPubkey,
    manualPubkey,
    manualPubkeyDialogOpen,
    manualPubkeyDraft,
    manualPubkeyError,
    manualPubkeyHint,
    manualPubkeyInputRef,
    manualPubkeyPasteButtonRef,
    openManualPubkeyDialog,
    rememberManualPubkey,
  } = useManualPubkeyDialog({
    initialManualPubkey,
    setTimelineView,
    signerPubkey,
    timelineView,
  });
  const configuredRelayUrls = normalizeRelayUrls(
    relaySettings.map((setting) => setting.url),
  );
  const activeRelayUrls = listActiveRelayUrls(relaySettings);
  const readRelayUrls = listReadRelayUrls(relaySettings);
  const writeRelayUrls = listWriteRelayUrls(relaySettings);
  const relayConfigurationKey = JSON.stringify({
    configured: configuredRelayUrls,
    active: activeRelayUrls,
    read: readRelayUrls,
    write: writeRelayUrls,
  });
  const {
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
    selectReferenceRelayHint,
    syncStatus,
    timeline,
    timelineRef,
  } = useRelayBootstrap({
    activeRelayUrls,
    configuredRelayUrls,
    readRelayUrls,
    relayBootstrapDeferred,
    relayConfigurationKey,
    relaySettings,
    timelineLimit: TIMELINE_LIMIT,
    writeRelayUrls,
  });
  const viewerPubkey = signerPubkey ?? manualPubkey;
  const canSignEvents = activeSignerKind === "local" || signerAvailable;
  const canOpenPersonalTimeline = canSignEvents || Boolean(viewerPubkey);
  const hasAutoSwitchedToFollowRef = useRef(false);
  const readyReadRelayCount = relayStatus.readyRelayCount;
  const debugRelayTransport = useMemo(
    () => createTemporaryRelayTransport(() => relayCoordinatorRef.current),
    [relayCoordinatorRef],
  );
  const focusRelayView = useCallback(() => {
    hasAutoSwitchedToFollowRef.current = true;
    setTimelineView("relay");
  }, []);

  const {
    clearFollowError,
    followDiagnostic,
    followError,
    followLoadState,
    followTimeline,
    primeFollowLoad,
    resetFollowState,
  } = useFollowTimeline({
    autoSignerPromptBlocked,
    ensureViewerPubkey,
    ingestOverlayEvents,
    isResolvingSignerPubkey,
    manualPubkey,
    markSignerUnavailable,
    profileSummariesRef,
    readRelayUrls,
    relayBootstrapDeferred,
    relayConfigurationKey,
    relayCoordinatorRef,
    readyReadRelayCount,
    signerAvailable,
    timeline,
    timelineLimit: TIMELINE_LIMIT,
    timelineRef,
    timelineView,
    viewerPubkey,
  });
  const {
    accountDiagnostic,
    accountError,
    accountLoadState,
    accountTimeline,
    clearAccountError,
    primeAccountLoad,
    rememberLocalPublishedEvent,
    resetAccountState,
  } = useAccountTimeline({
    autoSignerPromptBlocked,
    ensureViewerPubkey,
    ingestOverlayEvents,
    isResolvingSignerPubkey,
    manualPubkey,
    markSignerUnavailable,
    prefetchAccountTimeline: accountTabEnabled || notifyTabEnabled,
    profileSummariesRef,
    readRelayUrls,
    relayBootstrapDeferred,
    relayConfigurationKey,
    relayCoordinatorRef,
    readyReadRelayCount,
    signerAvailable,
    timeline,
    timelineLimit: TIMELINE_LIMIT,
    timelineRef,
    timelineView,
    viewerPubkey,
  });
  const {
    clearNotifyError,
    liveReactionNotice,
    notifyDiagnostic,
    notifyError,
    notifyLoadState,
    notifyTimeline,
    primeNotifyLoad,
    resetNotifyState,
  } = useNotifyTimeline({
    accountTimeline,
    autoSignerPromptBlocked,
    ensureViewerPubkey,
    ingestOverlayEvents,
    isResolvingSignerPubkey,
    manualPubkey,
    markSignerUnavailable,
    notifyTabEnabled,
    profileSummariesRef,
    readRelayUrls,
    relayBootstrapDeferred,
    relayConfigurationKey,
    relayCoordinatorRef,
    readyReadRelayCount,
    signerAvailable,
    timeline,
    timelineLimit: TIMELINE_LIMIT,
    timelineRef,
    timelineView,
    viewerPubkey,
  });
  const {
    clearReactionError,
    primeReactionLoad,
    reactionDiagnostic,
    reactionError,
    reactionLoadState,
    reactionTimeline,
    rememberLocalReactionTarget,
    resetReactionState,
    viewerReactionStateByTargetId,
  } = useReactionTimeline({
    autoSignerPromptBlocked,
    ensureViewerPubkey,
    ingestOverlayEvents,
    isResolvingSignerPubkey,
    manualPubkey,
    markSignerUnavailable,
    profileSummariesRef,
    readRelayUrls,
    reactionTabEnabled,
    relayBootstrapDeferred,
    relayConfigurationKey,
    relayCoordinatorRef,
    readyReadRelayCount,
    signerAvailable,
    timeline,
    timelineLimit: TIMELINE_LIMIT,
    timelineRef,
    timelineView,
    viewerPubkey,
  });
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    document.documentElement.dataset.theme = themePreference;
    document.documentElement.style.colorScheme = themePreference;
  }, [themePreference]);

  useEffect(() => {
    if (
      !viewerPubkey
      || timelineView !== "relay"
      || hasAutoSwitchedToFollowRef.current
    ) {
      return;
    }

    hasAutoSwitchedToFollowRef.current = true;
    setTimelineView("follow");
  }, [timelineView, viewerPubkey]);

  useEffect(() => {
    const hiddenCurrentView =
      (timelineView === "account" && !accountTabEnabled)
      || (timelineView === "notify" && !notifyTabEnabled)
      || (timelineView === "reaction" && !reactionTabEnabled);

    if (!hiddenCurrentView) {
      return;
    }

    hasAutoSwitchedToFollowRef.current = true;
    setTimelineView(canOpenPersonalTimeline ? "follow" : "relay");
  }, [
    accountTabEnabled,
    canOpenPersonalTimeline,
    notifyTabEnabled,
    reactionTabEnabled,
    timelineView,
  ]);

  useEffect(() => {
    saveRelaySettings(relaySettings);
    void saveRelaySettingsSnapshot(relaySettings);
  }, [relaySettings]);

  useEffect(() => {
    if (viewerPubkey) {
      setAutoSignerPromptBlocked(false);
    }
  }, [setAutoSignerPromptBlocked, viewerPubkey]);

  useEffect(() => {
    if (canSignEvents && signerPubkey && !composerWelcomeDismissed) {
      setComposerWelcomeMessage((current) => current ?? pickComposerWelcomeMessage());
      return;
    }

    setComposerWelcomeMessage(null);
  }, [canSignEvents, composerWelcomeDismissed, signerPubkey]);

  useEffect(() => {
    if (
      !pendingFollowAfterNsecLogin
      || activeSignerKind !== "local"
      || !signerPubkey
    ) {
      return;
    }

    hasAutoSwitchedToFollowRef.current = true;
    setTimelineView("follow");

    if (followLoadState === "idle") {
      primeFollowLoad();
    }

    setPendingFollowAfterNsecLogin(false);
  }, [
    activeSignerKind,
    followLoadState,
    pendingFollowAfterNsecLogin,
    primeFollowLoad,
    signerPubkey,
  ]);

  useEffect(() => {
    if (relayBootstrapDeferred) {
      return;
    }

    resetFollowState();
    resetAccountState();
    resetNotifyState();
    resetReactionState();
  }, [
    relayBootstrapDeferred,
    relayConfigurationKey,
    resetAccountState,
    resetFollowState,
    resetNotifyState,
    resetReactionState,
  ]);

  function handleProfileImagesToggle(event: ChangeEvent<HTMLInputElement>) {
    const enabled = event.target.checked;

    setProfileImagesEnabled(enabled);
    saveProfileImagesEnabled(enabled);
  }

  function handleDeveloperModeToggle(event: ChangeEvent<HTMLInputElement>) {
    const enabled = event.target.checked;

    setDeveloperModeEnabled(enabled);
    if (!enabled) {
      setPhysicsEnabled(false);
    }
    saveDeveloperModeEnabled(enabled);
  }

  function handlePhysicsToggle(event: ChangeEvent<HTMLInputElement>) {
    const enabled = event.target.checked;

    setPhysicsEnabled(enabled);
  }

  function handleAccountTabToggle(event: ChangeEvent<HTMLInputElement>) {
    const enabled = event.target.checked;

    setAccountTabEnabled(enabled);
    saveAccountTabEnabled(enabled);
  }

  function handleNotifyTabToggle(event: ChangeEvent<HTMLInputElement>) {
    const enabled = event.target.checked;

    setNotifyTabEnabled(enabled);
    saveNotifyTabEnabled(enabled);
  }

  function handleReactionTabToggle(event: ChangeEvent<HTMLInputElement>) {
    const enabled = event.target.checked;

    setReactionTabEnabled(enabled);
    saveReactionTabEnabled(enabled);
  }

  function handleThemePreferenceChange(preference: ThemePreference) {
    setThemePreference(preference);
    saveThemePreference(preference);
  }

  async function handleClearLocalData() {
    if (
      typeof window !== "undefined"
      && !window.confirm(
        "Yodaka のキャッシュと設定を全消去して再読み込みしますか？",
      )
    ) {
      return;
    }

    try {
      await clearActiveSigner();
      clearAppStorage();
      await clearCacheDatabase();
      settingsMenuRef.current?.removeAttribute("open");
      window.location.reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRelaySettingsError(`ローカルデータの消去に失敗しました: ${message}`);
    }
  }

  function handleRelayDraftChange(event: ChangeEvent<HTMLInputElement>) {
    setRelayDraftUrl(event.target.value);

    if (relaySettingsError) {
      setRelaySettingsError(null);
    }
  }

  async function handleCopyEventId(eventId: string) {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      return;
    }

    await navigator.clipboard.writeText(encodeNevent(eventId) ?? eventId);
  }

  async function handleViewEventJson(item: TimelineItem) {
    void loadEventJsonDialog();
    const title = `event ${item.id.slice(0, 12)}`;
    setEventJsonDialogState({
      isOpen: true,
      title,
      jsonText: "読み込み中...",
    });

    try {
      const rawEvent = readyReadRelayCount > 0
        ? await fetchLatestEventByIdAcrossRelays(
          readRelayUrls,
          item.id,
          debugRelayTransport,
        )
        : null;

      setEventJsonDialogState({
        isOpen: true,
        title,
        jsonText: formatDebugEventJson(rawEvent, item),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setEventJsonDialogState({
        isOpen: true,
        title,
        jsonText: `${formatDebugEventJson(null, item)}\n\n/* fetch error: ${message} */`,
      });
    }
  }

  async function handleCopyEventJson() {
    if (
      typeof navigator === "undefined"
      || !navigator.clipboard?.writeText
      || !eventJsonDialogState.jsonText
    ) {
      return;
    }

    await navigator.clipboard.writeText(eventJsonDialogState.jsonText);
  }

  function handleRelayToggle(url: string) {
    setRelaySettings((current) =>
      current.map((setting) =>
        setting.url === url
          ? {
              ...setting,
              enabled: !setting.enabled,
            }
          : setting,
      ),
    );
  }

  function handleRelayRoleToggle(url: string, role: "read" | "write") {
    setRelaySettings((current) =>
      current.map((setting) =>
        setting.url === url
          ? {
              ...setting,
              [role]: !setting[role],
            }
          : setting,
      ),
    );
  }

  function handleRelayMove(url: string, direction: -1 | 1) {
    setRelaySettings((current) => moveRelaySettings(current, url, direction));
  }

  function handleRelayRemove(url: string) {
    setRelaySettings((current) =>
      current.filter((setting) => setting.url !== url),
    );
  }

  function handleRelayReset() {
    setRelaySettings(buildDefaultRelaySettings());
    setRelayDraftUrl("");
    setRelaySettingsError(null);
  }

  function handleRelayAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const normalizedRelayUrl = normalizeRelayUrls([relayDraftUrl])[0];

    if (!normalizedRelayUrl) {
      setRelaySettingsError(
        "wss:// の relay URL を入力してください（開発用 localhost のみ ws:// 可）",
      );
      return;
    }

    setRelaySettings((current) => {
      const existing = current.find((setting) => setting.url === normalizedRelayUrl);

      if (existing) {
        return current.map((setting) =>
          setting.url === normalizedRelayUrl
            ? {
                ...setting,
                enabled: true,
              }
            : setting,
        );
      }

      return [
        ...current,
        {
          url: normalizedRelayUrl,
          enabled: true,
          read: true,
          write: true,
          nip65Managed: false,
        },
      ];
    });
    setRelayDraftUrl("");
    setRelaySettingsError(null);
  }

  function handleOpenSignerDialog() {
    void loadSignerDialog();
    clearSignerRequestFeedback();
    setSignerDialogOpen(true);
  }

  function handleKeyMinerToggleClick() {
    if (!keyMinerOpen) {
      void loadKeyMinerPanel();
    }

    handleKeyMinerToggle();
  }

  function handleCloseSignerDialog() {
    setPendingAuthenticatedTimelineAction(null);
    setSignerDialogOpen(false);
  }

  async function handleUseNip07FromDialog() {
    const pubkey = await requestNip07PubkeyFromUserGesture({
      forceRefresh: true,
    });

    if (pubkey) {
      rememberManualPubkey(pubkey);
      hasAutoSwitchedToFollowRef.current = true;
      setTimelineView("follow");

      if (followLoadState === "idle") {
        primeFollowLoad();
      }

      setSignerDialogOpen(false);
    }

    return pubkey;
  }

  async function handleUseNsecFromDialog(nsec: string) {
    await loginWithNsec(nsec);
    const pubkey = await refreshLocalSignerSession();

    if (!pubkey) {
      throw new Error("local signer session の初期化に失敗しました");
    }

    rememberManualPubkey(pubkey);
    setPendingFollowAfterNsecLogin(true);
    setSignerDialogOpen(false);
    return pubkey;
  }

  async function handleClearCurrentSignerFromDialog() {
    await clearActiveSigner();
    setPendingFollowAfterNsecLogin(false);
    setPendingAuthenticatedTimelineAction(null);

    if (!manualPubkey && timelineView !== "relay") {
      setTimelineView("relay");
    }
  }

  async function handleOpenManualPubkeyFromSignerDialog() {
    if (signerPubkey) {
      await clearActiveSigner();
      setPendingFollowAfterNsecLogin(false);
    }

    setPendingAuthenticatedTimelineAction(null);
    setSignerDialogOpen(false);
    openManualPubkeyDialog(viewerPubkey);
  }

  async function handleTimelineViewChange(view: TimelineView) {
    hasAutoSwitchedToFollowRef.current = true;

    if (focusedEventRoute) {
      clearFocusedEventRoute();
    }

    if (view !== "relay" && !viewerPubkey && signerAvailable) {
      try {
        await requestSignerPubkeyFromUserGesture();
      } catch {
        // 承認が得られなかった場合でも view は切り替えてエラーを表示する
      }
    }

    setTimelineView(view);

    if (view === "relay") {
      clearFollowError();
      clearAccountError();
      clearNotifyError();
      clearReactionError();
      return;
    }

    if (view === "follow" && followLoadState === "idle") {
      primeFollowLoad();
    }

    if (view === "follow" && accountLoadState === "idle") {
      primeAccountLoad();
    }

    if (view === "notify" && notifyLoadState === "idle") {
      primeNotifyLoad();
    }

    if (view === "reaction" && reactionLoadState === "idle") {
      primeReactionLoad();
    }

    if (view === "account" && accountLoadState === "idle") {
      primeAccountLoad();
    }
  }

  const baseVisibleTimeline = buildVisibleTimeline({
    accountTimeline,
    followTimeline,
    notifyTimeline,
    overlayEventIds,
    profileSummaries: profileSummariesRef.current,
    reactionTimeline,
    timeline,
    timelineLimit: TIMELINE_LIMIT,
    timelineView,
  });
  const baseTimelineSourceItems = useMemo(
    () => [
      ...timeline,
      ...followTimeline,
      ...accountTimeline,
      ...notifyTimeline,
      ...reactionTimeline,
    ],
    [accountTimeline, followTimeline, notifyTimeline, reactionTimeline, timeline],
  );
  const baseTimelineSourceItemsById = useMemo(
    () => new Map(baseTimelineSourceItems.map((item) => [item.id, item] as const)),
    [baseTimelineSourceItems],
  );
  const {
    clearFocusedEventRoute,
    focusedEventDisplayItem,
    focusedEventFetchError,
    focusedEventFetchState,
    focusedEventRoute,
  } = useFocusedEventRoute({
    initialFocusedEventRoute,
    onEnterFocusedRelayView: focusRelayView,
    profileSummariesRef,
    queueProfileLookupRef,
    readRelayUrls,
    referenceItems: baseTimelineSourceItems,
    referenceItemsById: baseTimelineSourceItemsById,
    timelineView,
    transport: debugRelayTransport,
  });
  const previewVisibleTimeline = useMemo(
    () => (
      focusedEventRoute
        ? buildFocusedThreadTimeline({
          focusedItem: focusedEventDisplayItem,
          referenceItems: baseTimelineSourceItems,
          timelineLimit: TIMELINE_LIMIT,
        })
        : baseVisibleTimeline
    ),
    [
      baseTimelineSourceItems,
      baseVisibleTimeline,
      focusedEventDisplayItem,
      focusedEventRoute,
    ],
  );
  const replyPreviewReferenceItems = useMemo(
    () => (
      focusedEventDisplayItem
        ? [...baseTimelineSourceItems, focusedEventDisplayItem]
        : baseTimelineSourceItems
    ),
    [baseTimelineSourceItems, focusedEventDisplayItem],
  );
  const {
    replyPreviewItems,
    replyPreviewStatuses,
  } = useReplyPreviewCache({
    profileSummariesRef,
    readRelayUrls,
    referenceItems: replyPreviewReferenceItems,
    timelineView,
    transport: debugRelayTransport,
    visibleTimeline: previewVisibleTimeline,
  });
  const baseTimelineReferenceItems = useMemo(
    () => [...replyPreviewReferenceItems, ...replyPreviewItems],
    [replyPreviewItems, replyPreviewReferenceItems],
  );
  const {
    contentEventPreviewItems,
  } = useContentEventPreviewCache({
    profileSummariesRef,
    readRelayUrls,
    referenceItems: baseTimelineReferenceItems,
    transport: debugRelayTransport,
    visibleTimeline: previewVisibleTimeline,
  });
  const baseTimelineReferenceItemsWithContent = useMemo(
    () => [...baseTimelineReferenceItems, ...contentEventPreviewItems],
    [baseTimelineReferenceItems, contentEventPreviewItems],
  );
  const timelineReferenceItems = useMemo(() => {
    if (!focusedEventDisplayItem) {
      return baseTimelineReferenceItemsWithContent;
    }

    return baseTimelineReferenceItemsWithContent.some(
      (item) => item.id === focusedEventDisplayItem.id,
    )
      ? baseTimelineReferenceItemsWithContent
      : [...baseTimelineReferenceItemsWithContent, focusedEventDisplayItem];
  }, [baseTimelineReferenceItemsWithContent, focusedEventDisplayItem]);
  const publishReferenceItemsById = useMemo(
    () => new Map(timelineReferenceItems.map((item) => [item.id, item] as const)),
    [timelineReferenceItems],
  );
  const {
    beginReply,
    cancelReply,
    clearPublishFeedback,
    draftContent,
    handleDraftContentChange,
    handleDraftKeyDown,
    handlePublish,
    handleReaction,
    handleRepost,
    isPublishing,
    pendingReactionEventIds,
    pendingReactionIntentsByEventId,
    publishError,
    publishMessage,
    replyTargetItem,
  } = usePublish({
    adoptNip07SignerPubkey,
    applyRelayPublishDiagnostics,
    countReadyWriteRelays,
    createActiveSigner,
    ensureSignerPubkey,
    markSignerUnavailable,
    queueProfileLookupRef,
    rememberLocalPublishedEvent,
    referenceItemsById: publishReferenceItemsById,
    refreshSnapshotRef,
    relayCoordinatorRef,
    requestSignerPubkeyFromUserGesture,
    rememberLocalReactionTarget,
    scheduleRefreshRef,
    selectReferenceRelayHint,
    signerPubkey,
    viewerPubkey,
    writeRelayUrls,
  });
  const visibleTimeline = previewVisibleTimeline;
  const relayButtonTitle = buildRelayButtonTitle(activeRelayUrls, relayStatus);
  const readyWriteRelayCount = countReadyWriteRelays();
  const canComposeNotes = canSignEvents && Boolean(signerPubkey);
  const canStartReply = canOpenPersonalTimeline;
  const canSendReaction = canOpenPersonalTimeline;
  const requiresSignerSelectionForViewerAction =
    Boolean(viewerPubkey) && !canSignEvents;
  const composerNotifyMessage = composerNotifyQueue[0]?.text ?? null;
  const activeComposerNotifyId = composerNotifyQueue[0]?.id ?? null;
  const handleComposerClearFeedback = useCallback(() => {
    clearSignerRequestFeedback();
    clearPublishFeedback();
  }, [clearPublishFeedback, clearSignerRequestFeedback]);
  useEffect(() => {
    if (
      !pendingAuthenticatedTimelineAction
      || !signerPubkey
      || signerDialogOpen
      || isPublishing
    ) {
      return;
    }

    setPendingAuthenticatedTimelineAction(null);

    if (pendingAuthenticatedTimelineAction.type === "reaction") {
      void handleReaction(
        pendingAuthenticatedTimelineAction.item,
        pendingAuthenticatedTimelineAction.reactionIntent,
      );
      return;
    }

    void handleRepost(pendingAuthenticatedTimelineAction.item);
  }, [
    handleReaction,
    handleRepost,
    isPublishing,
    pendingAuthenticatedTimelineAction,
    signerDialogOpen,
    signerPubkey,
  ]);
  const runtimeComposerError = publishError ?? signerRequestError;
  const runtimeComposerMessage =
    runtimeComposerError ? null : publishMessage ?? signerRequestMessage;
  const composerError = developerModeEnabled ? runtimeComposerError : null;
  const composerMessage = developerModeEnabled
    ? runtimeComposerMessage ?? composerWelcomeMessage
    : runtimeComposerError || runtimeComposerMessage
      ? null
      : composerWelcomeMessage;
  const timelineEmptyMessage = focusedEventRoute
    ? focusedEventFetchState === "loading"
      ? "ポストを取得中..."
      : focusedEventFetchError ?? "ポストが見つかりません"
    : buildTimelineEmptyMessage(
      timelineView,
      followLoadState,
      accountLoadState,
      notifyLoadState,
      reactionLoadState,
      timelineView === "follow" ? visibleTimeline.length : followTimeline.length,
      timelineView === "notify" ? visibleTimeline.length : notifyTimeline.length,
      timelineView === "reaction" ? visibleTimeline.length : reactionTimeline.length,
      accountError,
      followError,
      notifyError,
      reactionError,
    );
  const activeTimelineDiagnostics = focusedEventRoute
    ? []
    : timelineView === "follow"
      ? [followDiagnostic, accountDiagnostic]
      : timelineView === "account"
        ? [accountDiagnostic]
        : timelineView === "notify"
          ? [notifyDiagnostic]
          : timelineView === "reaction"
            ? [reactionDiagnostic]
            : [];

  useEffect(() => {
    if (!replyTargetItem || !canComposeNotes) {
      return;
    }

    composerTextareaRef.current?.focus();
    composerTextareaRef.current?.scrollIntoView({
      block: "nearest",
    });
  }, [canComposeNotes, replyTargetItem]);

  useEffect(() => {
    if (!liveReactionNotice) {
      return;
    }

    const reactionLabel = formatReactionContentLabel(liveReactionNotice.content);

    setComposerWelcomeDismissed(true);

    setComposerNotifyQueue((current) => (
      current.some((entry) => entry.id === liveReactionNotice.eventId)
        ? current
        : [
          ...current,
          {
            id: liveReactionNotice.eventId,
            text: reactionLabel,
          },
        ]
    ));
  }, [liveReactionNotice]);

  useEffect(() => {
    if (!activeComposerNotifyId || typeof window === "undefined") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setComposerNotifyQueue((current) => (
        current[0]?.id === activeComposerNotifyId ? current.slice(1) : current
      ));
    }, COMPOSER_NOTIFY_TTL_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeComposerNotifyId]);

  function handleReply(item: TimelineItem) {
    handleComposerClearFeedback();
    beginReply(item);

    if (!canComposeNotes) {
      handleOpenSignerDialog();
    }
  }

  function handleRepostWithLoginFlow(item: TimelineItem) {
    handleComposerClearFeedback();

    if (requiresSignerSelectionForViewerAction) {
      setPendingAuthenticatedTimelineAction({
        item,
        type: "repost",
      });
      handleOpenSignerDialog();
      return;
    }

    void handleRepost(item);
  }

  function handleReactionWithLoginFlow(
    item: TimelineItem,
    reactionIntent: ReactionIntent,
  ) {
    handleComposerClearFeedback();

    if (requiresSignerSelectionForViewerAction) {
      setPendingAuthenticatedTimelineAction({
        item,
        reactionIntent,
        type: "reaction",
      });
      handleOpenSignerDialog();
      return;
    }

    void handleReaction(item, reactionIntent);
  }

  return (
    <main className="shell">
      <AppToolbar
        activeSignerKind={activeSignerKind}
        accountTabEnabled={accountTabEnabled}
        developerModeEnabled={developerModeEnabled}
        isResolvingSignerPubkey={isResolvingSignerPubkey}
        keyMinerOpen={keyMinerOpen}
        manualPubkey={manualPubkey}
        notifyTabEnabled={notifyTabEnabled}
        physicsEnabled={physicsEnabled}
        profileImagesEnabled={profileImagesEnabled}
        reactionTabEnabled={reactionTabEnabled}
        relayBootstrapDeferred={relayBootstrapDeferred}
        relayDiagnostics={relayDiagnostics}
        relayDraftUrl={relayDraftUrl}
        relaySettings={relaySettings}
        relaySettingsError={relaySettingsError}
        relayStatus={relayStatus}
        settingsMenuRef={settingsMenuRef}
        signerAvailable={signerAvailable}
        signerPubkey={signerPubkey}
        syncStatus={syncStatus}
        themePreference={themePreference}
        onAccountTabToggle={handleAccountTabToggle}
        onClearLocalData={handleClearLocalData}
        onDeveloperModeToggle={handleDeveloperModeToggle}
        onKeyMinerToggle={handleKeyMinerToggleClick}
        onNotifyTabToggle={handleNotifyTabToggle}
        onPhysicsToggle={handlePhysicsToggle}
        onProfileImagesToggle={handleProfileImagesToggle}
        onReactionTabToggle={handleReactionTabToggle}
        onRelayAdd={handleRelayAdd}
        onRelayDraftChange={handleRelayDraftChange}
        onRelayMove={handleRelayMove}
        onRelayRemove={handleRelayRemove}
        onRelayReset={handleRelayReset}
        onRelayRoleToggle={handleRelayRoleToggle}
        onRelayToggle={handleRelayToggle}
        onSignerDialogClick={handleOpenSignerDialog}
        onThemePreferenceChange={handleThemePreferenceChange}
      />

      {keyMinerOpen ? (
        <Suspense
          fallback={(
            <section className="panel">
              <p className="muted">Key miner を読み込んでいます...</p>
            </section>
          )}
        >
          <LazyKeyMinerPanel
            developerModeEnabled={developerModeEnabled}
            initialPrefix={keyMinerLaunchConfig.prefix}
            initialSuffix={keyMinerLaunchConfig.suffix}
          />
        </Suspense>
      ) : (
        <>
          {errorMessage ? (
            <section className="panel panel-error">
              <p className="panel-error-text">{errorMessage}</p>
            </section>
          ) : null}

          {canComposeNotes ? (
            <ComposerPanel
              draftContent={draftContent}
              errorMessage={composerError}
              isPublishing={isPublishing}
              noticeMessage={composerNotifyMessage}
              readyWriteRelayCount={readyWriteRelayCount}
              replyTargetItem={replyTargetItem}
              statusMessage={composerMessage}
              textareaRef={composerTextareaRef}
              onClearFeedback={handleComposerClearFeedback}
              onDraftChange={handleDraftContentChange}
              onDraftKeyDown={handleDraftKeyDown}
              onReplyCancel={cancelReply}
              onSubmit={handlePublish}
            />
          ) : null}

        <TimelinePanel
          accountTabEnabled={accountTabEnabled}
          canOpenPersonalTimeline={canOpenPersonalTimeline}
          canReply={canStartReply}
          canSendReaction={canSendReaction}
          developerModeEnabled={developerModeEnabled}
          emptyMessage={timelineEmptyMessage}
          focusedEventMode={Boolean(focusedEventRoute)}
          isProfileImageEnabled={profileImagesEnabled}
          isPublishing={isPublishing}
          notifyTabEnabled={notifyTabEnabled}
          physicsEnabled={physicsEnabled}
          onCopyEventId={handleCopyEventId}
          onRepost={handleRepostWithLoginFlow}
          onReply={handleReply}
          pendingReactionEventIds={pendingReactionEventIds}
          pendingReactionIntentsByEventId={pendingReactionIntentsByEventId}
          readyWriteRelayCount={readyWriteRelayCount}
          reactionTabEnabled={reactionTabEnabled}
          relayButtonTitle={relayButtonTitle}
          replyPreviewStatuses={replyPreviewStatuses}
          timelineDiagnostics={activeTimelineDiagnostics}
          timelineHeadingLabel={focusedEventRoute ? "Post" : "Timeline"}
          timelineReferenceItems={timelineReferenceItems}
          timelineView={timelineView}
          viewerReactionStateByTargetId={viewerReactionStateByTargetId}
          onReact={handleReactionWithLoginFlow}
          onTimelineViewChange={handleTimelineViewChange}
          onViewEventJson={handleViewEventJson}
          visibleTimeline={visibleTimeline}
        />
        </>
      )}

      <ManualPubkeyDialog
        closeDialog={closeManualPubkeyDialog}
        draftValue={manualPubkeyDraft}
        errorMessage={manualPubkeyError}
        hintMessage={manualPubkeyHint}
        inputRef={manualPubkeyInputRef}
        isOpen={manualPubkeyDialogOpen}
        isPasting={isPastingManualPubkey}
        pasteButtonRef={manualPubkeyPasteButtonRef}
        onClear={handleManualPubkeyClear}
        onDraftChange={handleManualPubkeyDraftChange}
        onPaste={handleManualPubkeyPaste}
        onSubmit={handleManualPubkeySubmit}
      />
      {signerDialogOpen ? (
        <Suspense
          fallback={(
            <div className="dialog-backdrop" role="presentation">
              <section
                className="dialog-panel"
                role="dialog"
                aria-modal="true"
                aria-labelledby="signer-dialog-loading-title"
              >
                <div className="dialog-copy">
                  <h2 id="signer-dialog-loading-title" className="dialog-title">
                    Signer
                  </h2>
                  <p className="muted dialog-text">読み込み中...</p>
                </div>
              </section>
            </div>
          )}
        >
          <LazySignerDialog
            canClearCurrentSigner={Boolean(signerPubkey)}
            isNip07Available={signerAvailable}
            isLocalSignerActive={activeSignerKind === "local"}
            isOpen={signerDialogOpen}
            isResolvingSignerPubkey={isResolvingSignerPubkey}
            onClearCurrentSigner={handleClearCurrentSignerFromDialog}
            onClose={handleCloseSignerDialog}
            onOpenManualPubkey={handleOpenManualPubkeyFromSignerDialog}
            onUseExtension={handleUseNip07FromDialog}
            onUseNsec={handleUseNsecFromDialog}
          />
        </Suspense>
      ) : null}
      {eventJsonDialogState.isOpen ? (
        <Suspense
          fallback={(
            <div className="dialog-backdrop" role="presentation">
              <section
                className="dialog-panel"
                role="dialog"
                aria-modal="true"
                aria-labelledby="event-json-loading-title"
              >
                <div className="dialog-copy">
                  <h2 id="event-json-loading-title" className="dialog-title">
                    {eventJsonDialogState.title}
                  </h2>
                  <p className="muted dialog-text">読み込み中...</p>
                </div>
              </section>
            </div>
          )}
        >
          <LazyEventJsonDialog
            isOpen={eventJsonDialogState.isOpen}
            jsonText={eventJsonDialogState.jsonText}
            onCopy={handleCopyEventJson}
            title={eventJsonDialogState.title}
            onClose={() => {
              setEventJsonDialogState((current) => ({
                ...current,
                isOpen: false,
              }));
            }}
          />
        </Suspense>
      ) : null}
    </main>
  );
}
