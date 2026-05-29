import {
  useEffect,
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
import {
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
import { KeyMinerPanel } from "../components/KeyMinerPanel";
import { ComposerPanel } from "../components/ComposerPanel";
import { ManualPubkeyDialog } from "../components/ManualPubkeyDialog";
import { SignerDialog } from "../components/SignerDialog";
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
import { loginWithNsec } from "../lib/wasm/client";

const TIMELINE_LIMIT = 50;

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
  const [accountTabEnabled, setAccountTabEnabled] = useState(() =>
    loadAccountTabEnabled(),
  );
  const [notifyTabEnabled, setNotifyTabEnabled] = useState(() =>
    loadNotifyTabEnabled(),
  );
  const [reactionTabEnabled, setReactionTabEnabled] = useState(() =>
    loadReactionTabEnabled(),
  );
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
  const {
    activeSignerKind,
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
  const [composerWelcomeMessage, setComposerWelcomeMessage] = useState<string | null>(null);
  const [timelineView, setTimelineView] = useState<TimelineView>(() =>
    initialManualPubkey ? "follow" : "relay",
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
    selectReactionRelayHint,
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

  const {
    clearFollowError,
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
    accountError,
    accountLoadState,
    accountTimeline,
    clearAccountError,
    primeAccountLoad,
    resetAccountState,
  } = useAccountTimeline({
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
    clearNotifyError,
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
    reactionError,
    reactionLoadState,
    reactionTimeline,
    rememberLocalReactionTarget,
    resetReactionState,
  } = useReactionTimeline({
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
    draftContent,
    handleDraftContentChange,
    handleDraftKeyDown,
    handlePublish,
    handleReaction,
    isPublishing,
    pendingReactionEventIds,
    publishError,
    publishMessage,
  } = usePublish({
    applyRelayPublishDiagnostics,
    countReadyWriteRelays,
    createActiveSigner,
    ensureSignerPubkey,
    markSignerUnavailable,
    queueProfileLookupRef,
    refreshSnapshotRef,
    relayCoordinatorRef,
    requestSignerPubkeyFromUserGesture,
    rememberLocalReactionTarget,
    scheduleRefreshRef,
    selectReactionRelayHint,
    signerPubkey,
    writeRelayUrls,
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
    if (canSignEvents && signerPubkey) {
      setComposerWelcomeMessage((current) => current ?? pickComposerWelcomeMessage());
      return;
    }

    setComposerWelcomeMessage(null);
  }, [canSignEvents, signerPubkey]);

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
    saveDeveloperModeEnabled(enabled);
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
    clearSignerRequestFeedback();
    setSignerDialogOpen(true);
  }

  function handleCloseSignerDialog() {
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

    if (!manualPubkey && timelineView !== "relay") {
      setTimelineView("relay");
    }
  }

  async function handleOpenManualPubkeyFromSignerDialog() {
    if (signerPubkey) {
      await clearActiveSigner();
      setPendingFollowAfterNsecLogin(false);
    }

    setSignerDialogOpen(false);
    openManualPubkeyDialog(viewerPubkey);
  }

  async function handleTimelineViewChange(view: TimelineView) {
    hasAutoSwitchedToFollowRef.current = true;

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

  const visibleTimeline = buildVisibleTimeline({
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
  const relayButtonTitle = buildRelayButtonTitle(activeRelayUrls, relayStatus);
  const readyWriteRelayCount = countReadyWriteRelays();
  const canSendReaction = canSignEvents;
  const composerError = publishError ?? signerRequestError;
  const composerMessage =
    composerError ? null : publishMessage ?? signerRequestMessage ?? composerWelcomeMessage;
  const timelineEmptyMessage = buildTimelineEmptyMessage(
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
        onKeyMinerToggle={handleKeyMinerToggle}
        onNotifyTabToggle={handleNotifyTabToggle}
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
        <KeyMinerPanel
          developerModeEnabled={developerModeEnabled}
          initialPrefix={keyMinerLaunchConfig.prefix}
          initialSuffix={keyMinerLaunchConfig.suffix}
        />
      ) : (
        <>
          {errorMessage ? (
            <section className="panel panel-error">
              <p className="panel-error-text">{errorMessage}</p>
            </section>
          ) : null}

          {canSignEvents && signerPubkey ? (
            <ComposerPanel
              draftContent={draftContent}
              errorMessage={composerError}
              isPublishing={isPublishing}
              readyWriteRelayCount={readyWriteRelayCount}
              statusMessage={composerMessage}
              onClearFeedback={clearSignerRequestFeedback}
              onDraftChange={handleDraftContentChange}
              onDraftKeyDown={handleDraftKeyDown}
              onSubmit={handlePublish}
            />
          ) : null}

        <TimelinePanel
          accountTabEnabled={accountTabEnabled}
          canOpenPersonalTimeline={canOpenPersonalTimeline}
          canSendReaction={canSendReaction}
          emptyMessage={timelineEmptyMessage}
          isProfileImageEnabled={profileImagesEnabled}
          isPublishing={isPublishing}
          notifyTabEnabled={notifyTabEnabled}
          pendingReactionEventIds={pendingReactionEventIds}
          readyWriteRelayCount={readyWriteRelayCount}
          reactionTabEnabled={reactionTabEnabled}
          relayButtonTitle={relayButtonTitle}
            timelineView={timelineView}
            onReact={handleReaction}
            onTimelineViewChange={handleTimelineViewChange}
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
      <SignerDialog
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
    </main>
  );
}
