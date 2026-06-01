import type {
  ChangeEventHandler,
  FormEventHandler,
  Ref,
} from "react";
import type { RelayDiagnosticState } from "../app/types";
import type { RelayStatus } from "../lib/nostr/relay";
import type { RelayCoordinatorStatus } from "../lib/nostr/relayCoordinator";
import type { RelaySetting } from "../lib/nostr/storage";
import { RelaySettingItem } from "./RelaySettingItem";

type RelaySettingsMenuProps = {
  accountTabEnabled: boolean;
  developerModeEnabled: boolean;
  keyMinerOpen: boolean;
  notifyTabEnabled: boolean;
  profileImagesEnabled: boolean;
  reactionTabEnabled: boolean;
  relayBootstrapDeferred: boolean;
  relayDiagnostics: Record<string, RelayDiagnosticState>;
  relayDraftUrl: string;
  relaySettings: RelaySetting[];
  relaySettingsError: string | null;
  relayStatus: RelayCoordinatorStatus;
  settingsMenuRef: Ref<HTMLDetailsElement>;
  onDeveloperModeToggle: ChangeEventHandler<HTMLInputElement>;
  onAccountTabToggle: ChangeEventHandler<HTMLInputElement>;
  onClearLocalData: () => void;
  onKeyMinerToggle: () => void;
  onNotifyTabToggle: ChangeEventHandler<HTMLInputElement>;
  onProfileImagesToggle: ChangeEventHandler<HTMLInputElement>;
  onReactionTabToggle: ChangeEventHandler<HTMLInputElement>;
  onRelayAdd: FormEventHandler<HTMLFormElement>;
  onRelayDraftChange: ChangeEventHandler<HTMLInputElement>;
  onRelayMove: (url: string, direction: -1 | 1) => void;
  onRelayRemove: (url: string) => void;
  onRelayReset: () => void;
  onRelayRoleToggle: (url: string, role: "read" | "write") => void;
  onRelayToggle: (url: string) => void;
};

export function RelaySettingsMenu(props: RelaySettingsMenuProps) {
  const enabledRelayCount = props.relaySettings.filter((setting) => setting.enabled).length;
  const relayStatusMap = new Map<string, RelayStatus>(
    props.relayStatus.relayStatuses.map((status) => [status.relayUrl, status]),
  );

  return (
    <details ref={props.settingsMenuRef} className="settings-menu">
      <summary className="settings-menu-summary">
        <span className="settings-menu-button" title="設定">
          <svg
            className="settings-menu-icon"
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="none"
          >
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83a2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33a1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0a2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1a1.65 1.65 0 0 0-.33-1.82L4.21 6.2a2 2 0 0 1 0-2.83a2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0a2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </span>
      </summary>
      <div className="settings-menu-panel">
        <div className="settings-menu-header">
          <span className="section-chip">設定</span>
          <span className="muted settings-menu-meta">
            {enabledRelayCount}/{props.relaySettings.length} 有効
          </span>
        </div>

        <div className="settings-menu-section">
          <div className="settings-menu-row">
            <span className="settings-menu-label">Account タブ</span>
            <label
              className={`chip-toggle settings-chip-toggle${
                props.accountTabEnabled ? " chip-toggle-active" : ""
              }`}
              title="Account タブ"
            >
              <input
                className="chip-toggle-input"
                type="checkbox"
                checked={props.accountTabEnabled}
                onChange={props.onAccountTabToggle}
                aria-label="Account タブ"
              />
              <span className="chip-toggle-icon" aria-hidden="true">
                {props.accountTabEnabled ? "◉" : "○"}
              </span>
              <span className="chip-toggle-label">
                {props.accountTabEnabled ? "ON" : "OFF"}
              </span>
            </label>
          </div>
          <div className="settings-menu-row">
            <span className="settings-menu-label">Notify タブ</span>
            <label
              className={`chip-toggle settings-chip-toggle${
                props.notifyTabEnabled ? " chip-toggle-active" : ""
              }`}
              title="Notify タブ"
            >
              <input
                className="chip-toggle-input"
                type="checkbox"
                checked={props.notifyTabEnabled}
                onChange={props.onNotifyTabToggle}
                aria-label="Notify タブ"
              />
              <span className="chip-toggle-icon" aria-hidden="true">
                {props.notifyTabEnabled ? "◉" : "○"}
              </span>
              <span className="chip-toggle-label">
                {props.notifyTabEnabled ? "ON" : "OFF"}
              </span>
            </label>
          </div>
          <div className="settings-menu-row">
            <span className="settings-menu-label">Reaction タブ</span>
            <label
              className={`chip-toggle settings-chip-toggle${
                props.reactionTabEnabled ? " chip-toggle-active" : ""
              }`}
              title="Reaction タブ"
            >
              <input
                className="chip-toggle-input"
                type="checkbox"
                checked={props.reactionTabEnabled}
                onChange={props.onReactionTabToggle}
                aria-label="Reaction タブ"
              />
              <span className="chip-toggle-icon" aria-hidden="true">
                {props.reactionTabEnabled ? "◉" : "○"}
              </span>
              <span className="chip-toggle-label">
                {props.reactionTabEnabled ? "ON" : "OFF"}
              </span>
            </label>
          </div>
          <div className="settings-menu-row">
            <span className="settings-menu-label">アイコン画像取得</span>
            <label
              className={`chip-toggle settings-chip-toggle${
                props.profileImagesEnabled ? " chip-toggle-active" : ""
              }`}
              title="アイコン画像取得"
            >
              <input
                className="chip-toggle-input"
                type="checkbox"
                checked={props.profileImagesEnabled}
                onChange={props.onProfileImagesToggle}
                aria-label="アイコン画像取得"
              />
              <span className="chip-toggle-icon" aria-hidden="true">
                {props.profileImagesEnabled ? "◉" : "○"}
              </span>
              <span className="chip-toggle-label">
                {props.profileImagesEnabled ? "ON" : "OFF"}
              </span>
            </label>
          </div>
          <div className="settings-menu-row">
            <span className="settings-menu-label">公開鍵マイニング</span>
            <button
              type="button"
              className="relay-settings-button relay-settings-button-secondary settings-menu-action-button"
              onClick={props.onKeyMinerToggle}
              title={props.keyMinerOpen ? "Key Miner を閉じる" : "Key Miner を開く"}
            >
              {props.keyMinerOpen ? "Close" : "Open"}
            </button>
          </div>
          <div className="settings-menu-row">
            <span className="settings-menu-label">開発者モード</span>
            <label
              className={`chip-toggle settings-chip-toggle${
                props.developerModeEnabled ? " chip-toggle-active" : ""
              }`}
              title="開発者モード"
            >
              <input
                className="chip-toggle-input"
                type="checkbox"
                checked={props.developerModeEnabled}
                onChange={props.onDeveloperModeToggle}
                aria-label="開発者モード"
              />
              <span className="chip-toggle-icon" aria-hidden="true">
                {props.developerModeEnabled ? "◉" : "○"}
              </span>
              <span className="chip-toggle-label">
                {props.developerModeEnabled ? "ON" : "OFF"}
              </span>
            </label>
          </div>
          <div className="settings-menu-row">
            <span className="settings-menu-label">ローカルデータ</span>
            <button
              type="button"
              className="relay-settings-button relay-settings-button-secondary settings-menu-action-button settings-menu-action-button-danger"
              onClick={props.onClearLocalData}
              title="キャッシュと設定を全消去して再読み込み"
            >
              全消去
            </button>
          </div>
        </div>

        <div className="relay-settings-body">
          <ul className="relay-settings-list">
            {props.relaySettings.map((setting, index) => {
              return (
                <RelaySettingItem
                  key={setting.url}
                  developerModeEnabled={props.developerModeEnabled}
                  index={index}
                  relayBootstrapDeferred={props.relayBootstrapDeferred}
                  relayDiagnostic={props.relayDiagnostics[setting.url]}
                  relaySetting={setting}
                  relayStatus={relayStatusMap.get(setting.url)}
                  totalCount={props.relaySettings.length}
                  onMove={props.onRelayMove}
                  onRemove={props.onRelayRemove}
                  onRoleToggle={props.onRelayRoleToggle}
                  onToggle={props.onRelayToggle}
                />
              );
            })}
          </ul>

          <form className="relay-settings-form" onSubmit={props.onRelayAdd}>
            <input
              className="relay-settings-input"
              value={props.relayDraftUrl}
              onChange={props.onRelayDraftChange}
              placeholder="wss://example.com"
              aria-label="relay URL"
            />
            <div className="relay-settings-form-actions">
              <button
                type="submit"
                className="relay-settings-button relay-settings-button-primary"
              >
                追加
              </button>
              <button
                type="button"
                className="relay-settings-button relay-settings-button-secondary"
                onClick={props.onRelayReset}
              >
                既定値へ戻す
              </button>
            </div>
          </form>

          {props.relaySettingsError ? (
            <p className="composer-feedback composer-status-error">
              {props.relaySettingsError}
            </p>
          ) : null}
        </div>
      </div>
    </details>
  );
}
