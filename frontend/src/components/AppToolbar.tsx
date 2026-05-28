import type {
  ChangeEventHandler,
  FormEventHandler,
  Ref,
} from "react";
import type { RelayDiagnosticState } from "../app/types";
import type { RelayCoordinatorStatus } from "../lib/nostr/relayCoordinator";
import type { SignerKind } from "../lib/nostr/signer";
import type {
  RelaySetting,
  ThemePreference,
} from "../lib/nostr/storage";
import {
  formatConnectionDetail,
  formatRelayStatus,
  formatRelayStatusTone,
} from "../lib/ui/relayDisplay";
import { buildSignerIndicator } from "../lib/ui/signerDisplay";
import {
  buildThemePreferenceIndicator,
  cycleThemePreference,
} from "../lib/ui/themeDisplay";
import { RelaySettingsMenu } from "./RelaySettingsMenu";

type AppToolbarProps = {
  activeSignerKind: SignerKind | null;
  developerModeEnabled: boolean;
  isResolvingSignerPubkey: boolean;
  keyMinerOpen: boolean;
  manualPubkey: string | null;
  profileImagesEnabled: boolean;
  relayBootstrapDeferred: boolean;
  relayDiagnostics: Record<string, RelayDiagnosticState>;
  relayDraftUrl: string;
  relaySettings: RelaySetting[];
  relaySettingsError: string | null;
  relayStatus: RelayCoordinatorStatus;
  settingsMenuRef: Ref<HTMLDetailsElement>;
  signerAvailable: boolean;
  signerPubkey: string | null;
  syncStatus: string;
  themePreference: ThemePreference;
  onClearLocalData: () => void;
  onDeveloperModeToggle: ChangeEventHandler<HTMLInputElement>;
  onKeyMinerToggle: () => void;
  onProfileImagesToggle: ChangeEventHandler<HTMLInputElement>;
  onRelayAdd: FormEventHandler<HTMLFormElement>;
  onRelayDraftChange: ChangeEventHandler<HTMLInputElement>;
  onRelayMove: (url: string, direction: -1 | 1) => void;
  onRelayRemove: (url: string) => void;
  onRelayReset: () => void;
  onRelayRoleToggle: (url: string, role: "read" | "write") => void;
  onRelayToggle: (url: string) => void;
  onSignerDialogClick: () => void;
  onThemePreferenceChange: (preference: ThemePreference) => void;
};

export function AppToolbar(props: AppToolbarProps) {
  const signerIndicator = buildSignerIndicator(
    props.activeSignerKind,
    props.signerAvailable,
    props.signerPubkey,
    props.manualPubkey,
    props.isResolvingSignerPubkey,
  );
  const connectionDetail = props.developerModeEnabled
    ? formatConnectionDetail(props.relayStatus)
    : null;
  const themePreferenceIndicator = buildThemePreferenceIndicator(props.themePreference);

  return (
    <section className="panel toolbar">
      <div className="toolbar-main">
        <div className="toolbar-status">
          <span
            className={`status-chip status-chip-${formatRelayStatusTone(props.relayStatus)}`}
            title={props.relayStatus.detail ?? props.syncStatus}
          >
            {formatRelayStatus(props.relayStatus)}
          </span>
          {connectionDetail ? (
            <p className="muted toolbar-detail">{connectionDetail}</p>
          ) : null}
        </div>

        <div className="toolbar-controls">
          <button
            type="button"
            className={`signer-badge signer-badge-${signerIndicator.tone}${
              signerIndicator.action !== "none" ? " signer-badge-button" : ""
            }`}
            title={signerIndicator.title}
            disabled={signerIndicator.action === "none"}
            onClick={
              signerIndicator.action === "dialog"
                ? props.onSignerDialogClick
                : undefined
            }
            aria-disabled={signerIndicator.action === "none"}
          >
            {signerIndicator.label}
          </button>

          <button
            type="button"
            className="settings-theme-button"
            onClick={() =>
              props.onThemePreferenceChange(
                cycleThemePreference(props.themePreference),
              )
            }
            aria-label={themePreferenceIndicator.title}
            title={themePreferenceIndicator.title}
          >
            {themePreferenceIndicator.icon}
          </button>

          <RelaySettingsMenu
            developerModeEnabled={props.developerModeEnabled}
            keyMinerOpen={props.keyMinerOpen}
            profileImagesEnabled={props.profileImagesEnabled}
            relayBootstrapDeferred={props.relayBootstrapDeferred}
            relayDiagnostics={props.relayDiagnostics}
            relayDraftUrl={props.relayDraftUrl}
            relaySettings={props.relaySettings}
            relaySettingsError={props.relaySettingsError}
            relayStatus={props.relayStatus}
            settingsMenuRef={props.settingsMenuRef}
            onClearLocalData={props.onClearLocalData}
            onDeveloperModeToggle={props.onDeveloperModeToggle}
            onKeyMinerToggle={props.onKeyMinerToggle}
            onProfileImagesToggle={props.onProfileImagesToggle}
            onRelayAdd={props.onRelayAdd}
            onRelayDraftChange={props.onRelayDraftChange}
            onRelayMove={props.onRelayMove}
            onRelayRemove={props.onRelayRemove}
            onRelayReset={props.onRelayReset}
            onRelayRoleToggle={props.onRelayRoleToggle}
            onRelayToggle={props.onRelayToggle}
          />
        </div>
      </div>
    </section>
  );
}
