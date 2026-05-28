import type { RelayDiagnosticState } from "../app/types";
import type { RelayStatus } from "../lib/nostr/relay";
import type { RelaySetting } from "../lib/nostr/storage";
import {
  buildRelayDiagnosticEntries,
  formatRelayRoles,
  formatRelaySettingStatus,
} from "../lib/ui/relayDisplay";

type RelaySettingItemProps = {
  developerModeEnabled: boolean;
  index: number;
  relayBootstrapDeferred: boolean;
  relayDiagnostic: RelayDiagnosticState | undefined;
  relaySetting: RelaySetting;
  relayStatus: RelayStatus | undefined;
  totalCount: number;
  onMove: (url: string, direction: -1 | 1) => void;
  onRemove: (url: string) => void;
  onRoleToggle: (url: string, role: "read" | "write") => void;
  onToggle: (url: string) => void;
};

export function RelaySettingItem(props: RelaySettingItemProps) {
  const statusInfo = formatRelaySettingStatus(
    props.relaySetting,
    props.relayStatus,
    props.relayBootstrapDeferred,
  );
  const diagnosticEntries = buildRelayDiagnosticEntries({
    setting: props.relaySetting,
    relayStatus: props.relayStatus,
    relayDiagnostic: props.relayDiagnostic,
    relayConnectionsDeferred: props.relayBootstrapDeferred,
  });

  return (
    <li className="relay-settings-item">
      <div className="relay-settings-copy">
        <span
          className={`relay-settings-status relay-settings-status-${statusInfo.tone}`}
          title={statusInfo.title}
        >
          {statusInfo.label}
        </span>
        <span className="relay-settings-url" title={props.relaySetting.url}>
          {props.relaySetting.url}
        </span>
        {props.developerModeEnabled ? (
          <span className="muted relay-settings-role-summary">
            {formatRelayRoles(props.relaySetting)}
          </span>
        ) : null}
      </div>
      <div className="relay-settings-actions">
        <label
          className={`chip-toggle relay-settings-toggle${
            props.relaySetting.enabled ? " chip-toggle-active" : ""
          }`}
          title={props.relaySetting.enabled ? "relay を無効化" : "relay を有効化"}
        >
          <input
            className="chip-toggle-input"
            type="checkbox"
            checked={props.relaySetting.enabled}
            onChange={() => props.onToggle(props.relaySetting.url)}
            aria-label={`${props.relaySetting.url} を有効化`}
          />
          <span className="chip-toggle-icon" aria-hidden="true">
            {props.relaySetting.enabled ? "◉" : "○"}
          </span>
          <span className="chip-toggle-label">
            {props.relaySetting.enabled ? "有効" : "無効"}
          </span>
        </label>
        {props.developerModeEnabled ? (
          <div className="relay-settings-roles">
            <label
              className={`chip-toggle relay-settings-role-toggle${
                props.relaySetting.read ? " chip-toggle-active" : ""
              }`}
              title={`${props.relaySetting.url} を read relay として使う`}
            >
              <input
                className="chip-toggle-input"
                type="checkbox"
                checked={props.relaySetting.read}
                onChange={() => props.onRoleToggle(props.relaySetting.url, "read")}
                aria-label={`${props.relaySetting.url} を read relay として使う`}
              />
              <span className="chip-toggle-icon" aria-hidden="true">
                {props.relaySetting.read ? "◉" : "○"}
              </span>
              <span className="chip-toggle-label">READ</span>
            </label>
            <label
              className={`chip-toggle relay-settings-role-toggle${
                props.relaySetting.write ? " chip-toggle-active" : ""
              }`}
              title={`${props.relaySetting.url} を write relay として使う`}
            >
              <input
                className="chip-toggle-input"
                type="checkbox"
                checked={props.relaySetting.write}
                onChange={() => props.onRoleToggle(props.relaySetting.url, "write")}
                aria-label={`${props.relaySetting.url} を write relay として使う`}
              />
              <span className="chip-toggle-icon" aria-hidden="true">
                {props.relaySetting.write ? "◉" : "○"}
              </span>
              <span className="chip-toggle-label">WRITE</span>
            </label>
          </div>
        ) : null}
        <button
          type="button"
          className="relay-settings-button relay-settings-button-secondary"
          onClick={() => props.onRemove(props.relaySetting.url)}
        >
          削除
        </button>
        <button
          type="button"
          className="relay-settings-button relay-settings-button-secondary relay-settings-button-icon"
          onClick={() => props.onMove(props.relaySetting.url, -1)}
          disabled={props.index === 0}
          title={props.index === 0 ? "これ以上上へ移動できません" : "上へ移動"}
          aria-label={`${props.relaySetting.url} を上へ移動`}
        >
          ↑
        </button>
        <button
          type="button"
          className="relay-settings-button relay-settings-button-secondary relay-settings-button-icon"
          onClick={() => props.onMove(props.relaySetting.url, 1)}
          disabled={props.index === props.totalCount - 1}
          title={
            props.index === props.totalCount - 1
              ? "これ以上下へ移動できません"
              : "下へ移動"
          }
          aria-label={`${props.relaySetting.url} を下へ移動`}
        >
          ↓
        </button>
      </div>
      <details className="relay-settings-details">
        <summary className="relay-settings-details-summary">
          診断を表示
        </summary>
        <div className="relay-settings-details-grid">
          {diagnosticEntries.map((entry) => (
            <div
              key={`${props.relaySetting.url}:${entry.label}`}
              className={`relay-settings-detail-item relay-settings-detail-item-${entry.tone}`}
            >
              <span className="relay-settings-detail-label">
                {entry.label}
              </span>
              <span className="relay-settings-detail-value">
                {entry.value}
              </span>
            </div>
          ))}
        </div>
      </details>
    </li>
  );
}
