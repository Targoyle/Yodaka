import type { RelayDiagnosticState } from "../../app/types";
import type { RelayStatus as RelayConnectionStatus } from "../nostr/relay";
import type {
  RelayCoordinatorStatus,
} from "../nostr/relayCoordinator";
import type { RelaySetting } from "../nostr/storage";
import {
  formatRelayAccessLabel,
  formatRelayAccessMessage,
  parseRelayAuthMessage,
} from "../nostr/relayAuth";
import {
  formatCreatedAt,
  formatRecordedAt,
  formatRetryDelay,
} from "./formatters";

export function formatRelayStatus(status: RelayCoordinatorStatus) {
  switch (status.phase) {
    case "idle":
      return "🟡 IDLE";

    case "paused":
      return "🟡 PAUSED";

    case "connecting":
      return "🟡 CONNECTING";

    case "subscribing":
      return "🟡 SYNCING";

    case "partial":
      return "🟡 PARTIAL";

    case "live":
      return "🟢 LIVE";

    case "degraded":
      return "🟡 DEGRADED";

    case "offline":
      return "🔴 OFFLINE";

    case "closed":
      return "🔴 CLOSED";
  }
}

export function formatRelayStatusTone(status: RelayCoordinatorStatus) {
  if (status.phase === "live") {
    return "live";
  }

  if (
    status.phase === "paused"
    || status.phase === "partial"
    || status.phase === "degraded"
  ) {
    return "pending";
  }

  if (status.phase === "closed" || status.phase === "offline") {
    return "closed";
  }

  return "pending";
}

export function formatConnectionDetail(status: RelayCoordinatorStatus) {
  if (status.phase === "paused") {
    return status.detail ?? "relay 接続を保留しています";
  }

  if (status.relayCount === 0) {
    return null;
  }

  const phaseCounts = {
    connecting: 0,
    subscribing: 0,
    reconnecting: 0,
    closed: 0,
  };

  for (const relayStatus of status.relayStatuses) {
    if (relayStatus.phase === "connecting") {
      phaseCounts.connecting += 1;
      continue;
    }

    if (relayStatus.phase === "subscribing") {
      phaseCounts.subscribing += 1;
      continue;
    }

    if (relayStatus.phase === "reconnecting") {
      phaseCounts.reconnecting += 1;
      continue;
    }

    if (relayStatus.phase === "closed") {
      phaseCounts.closed += 1;
    }
  }

  const parts = [];

  if (status.liveRelayCount > 0) {
    parts.push(`${status.liveRelayCount} live`);
  }

  if (phaseCounts.subscribing > 0) {
    parts.push(`${phaseCounts.subscribing} syncing`);
  }

  if (phaseCounts.connecting > 0) {
    parts.push(`${phaseCounts.connecting} connecting`);
  }

  if (phaseCounts.reconnecting > 0) {
    parts.push(`${phaseCounts.reconnecting} reconnecting`);
  }

  if (phaseCounts.closed > 0) {
    parts.push(`${phaseCounts.closed} closed`);
  }

  return parts.length > 0 ? parts.join(" / ") : `${status.relayCount} relay`;
}

export function buildRelayButtonTitle(
  relayUrls: string[],
  status: RelayCoordinatorStatus,
) {
  if (relayUrls.length === 0) {
    return "relay が設定されていません";
  }

  const relayStatusMap = new Map(
    status.relayStatuses.map((relayStatus) => [relayStatus.relayUrl, relayStatus]),
  );

  return [
    "Relay 接続先",
    ...(status.phase === "paused" && status.detail ? [status.detail] : []),
    ...relayUrls.map((relayUrl) => {
      const relayStatus = relayStatusMap.get(relayUrl);
      const icon = formatRelayTooltipIcon(relayStatus?.phase);
      const detail = relayStatus?.detail ? ` - ${relayStatus.detail}` : "";

      return `${icon} ${relayUrl}${detail}`;
    }),
  ].join("\n");
}

export function formatRelaySettingStatus(
  setting: RelaySetting,
  relayStatus: RelayConnectionStatus | undefined,
  relayConnectionsDeferred: boolean,
) {
  if (!setting.enabled) {
    return {
      tone: "disabled" as const,
      label: "無効",
      title: "この relay は無効です",
    };
  }

  if (!setting.read && !setting.write) {
    return {
      tone: "idle" as const,
      label: "IDLE",
      title: "relay has no active read/write role",
    };
  }

  if (relayConnectionsDeferred) {
    return {
      tone: "pending" as const,
      label: "PAUSED",
      title: "Key Miner 直開きのため relay 接続を保留しています",
    };
  }

  switch (relayStatus?.phase) {
    case "live":
      return {
        tone: "live" as const,
        label: "LIVE",
        title: relayStatus.detail ?? "relay は live です",
      };

    case "connecting":
      return {
        tone: "pending" as const,
        label: "CONNECTING",
        title: relayStatus.detail ?? "relay is connecting",
      };

    case "subscribing":
      return {
        tone: "pending" as const,
        label: "SYNCING",
        title: relayStatus.detail ?? "relay is syncing",
      };

    case "reconnecting":
      return {
        tone: "pending" as const,
        label: "RECONNECTING",
        title: relayStatus.detail ?? "relay is reconnecting",
      };

    case "closed":
      return {
        tone: "closed" as const,
        label: "CLOSED",
        title: relayStatus.detail ?? "relay is closed",
      };

    default:
      return {
        tone: "idle" as const,
        label: "IDLE",
        title: "relay is idle",
      };
  }
}

export function buildRelayDiagnosticEntries(args: {
  setting: RelaySetting;
  relayStatus: RelayConnectionStatus | undefined;
  relayDiagnostic: RelayDiagnosticState | undefined;
  relayConnectionsDeferred: boolean;
}) {
  const relayDiagnostic = args.relayDiagnostic ?? buildEmptyRelayDiagnostic();
  const entries: Array<{
    label: string;
    value: string;
    tone: "default" | "muted" | "error";
  }> = [
    {
      label: "現在",
      value: args.setting.enabled
        ? (!args.setting.read && !args.setting.write
            ? "read/write role が未設定です"
            : args.relayConnectionsDeferred
              ? "Key Miner 直開きのため接続保留"
              : args.relayStatus?.detail ?? "relay is idle")
        : "この relay は無効です",
      tone: "default" as const,
    },
    {
      label: "役割",
      value: formatRelayRoles(args.setting),
      tone:
        args.setting.read || args.setting.write
          ? ("default" as const)
          : ("muted" as const),
    },
    {
      label: "since_hint",
      value: formatRelaySinceHint(relayDiagnostic.sinceHint),
      tone:
        relayDiagnostic.sinceHint === null ? ("muted" as const) : ("default" as const),
    },
    {
      label: "最終 live",
      value: formatRecordedAt(relayDiagnostic.lastConnected),
      tone:
        relayDiagnostic.lastConnected > 0 ? ("default" as const) : ("muted" as const),
    },
  ];

  if (args.relayStatus) {
    entries.push({
      label: "試行回数",
      value: `${args.relayStatus.attempt} 回`,
      tone: "default" as const,
    });
  }

  if (args.relayStatus?.retryInMs) {
    entries.push({
      label: "次回再接続",
      value: formatRetryDelay(args.relayStatus.retryInMs),
      tone: "default" as const,
    });
  }

  if (relayDiagnostic.lastStatusAt) {
    entries.push({
      label: "最終更新",
      value: formatRecordedAt(relayDiagnostic.lastStatusAt),
      tone: "default" as const,
    });
  }

  if (relayDiagnostic.lastPublishError) {
    const formattedPublishError =
      formatRelayAccessMessage(relayDiagnostic.lastPublishError)
      ?? relayDiagnostic.lastPublishError;
    entries.push({
      label: formatRelayAccessLabel(relayDiagnostic.lastPublishError, "直近 publish 失敗"),
      value: formattedPublishError,
      tone: "error" as const,
    });
  }

  if (relayDiagnostic.lastError) {
    entries.push({
      label: "直近エラー",
      value: relayDiagnostic.lastError,
      tone: "error" as const,
    });
  }

  if (relayDiagnostic.lastAuthChallenge) {
    entries.push({
      label: "直近 AUTH",
      value: relayDiagnostic.lastAuthChallenge,
      tone: "muted" as const,
    });
  }

  if (relayDiagnostic.lastClosedMessage) {
    const parsedClosed = parseRelayAuthMessage(relayDiagnostic.lastClosedMessage);
    entries.push({
      label: formatRelayAccessLabel(relayDiagnostic.lastClosedMessage, "直近 CLOSED"),
      value:
        formatRelayAccessMessage(relayDiagnostic.lastClosedMessage)
        ?? relayDiagnostic.lastClosedMessage,
      tone: parsedClosed.requirement ? ("error" as const) : ("muted" as const),
    });
  }

  if (relayDiagnostic.lastNotice) {
    entries.push({
      label: "直近 NOTICE",
      value: relayDiagnostic.lastNotice,
      tone: "muted" as const,
    });
  }

  return entries;
}

export function formatRelayRoles(setting: RelaySetting) {
  if (setting.read && setting.write) {
    return "READ / WRITE";
  }

  if (setting.read) {
    return "READ";
  }

  if (setting.write) {
    return "WRITE";
  }

  return "未割当";
}

export function formatRelayTooltipIcon(phase?: string) {
  switch (phase) {
    case "live":
      return "🟢";

    case "paused":
    case "connecting":
    case "subscribing":
    case "reconnecting":
      return "🟡";

    case "closed":
      return "🔴";

    default:
      return "⚪";
  }
}

export function buildInitialRelayStatus(
  relayUrls: string[],
): RelayCoordinatorStatus {
  return {
    phase: "idle",
    relayCount: relayUrls.length,
    readyRelayCount: 0,
    liveRelayCount: 0,
    relayStatuses: [],
    detail: relayUrls.length > 0 ? "idle" : "relay が設定されていません",
  };
}

export function buildDeferredRelayStatus(
  relayUrls: string[],
): RelayCoordinatorStatus {
  return {
    phase: "paused",
    relayCount: relayUrls.length,
    readyRelayCount: 0,
    liveRelayCount: 0,
    relayStatuses: [],
    detail:
      relayUrls.length > 0
        ? "Key Miner 直開きのため relay 接続を保留"
        : "relay が設定されていません",
  };
}

export function buildInitialRelayDiagnostics(relaySettings: RelaySetting[]) {
  return Object.fromEntries(
    relaySettings.map((setting) => [setting.url, buildEmptyRelayDiagnostic()]),
  ) as Record<string, RelayDiagnosticState>;
}

export function buildEmptyRelayDiagnostic(): RelayDiagnosticState {
  return {
    sinceHint: null,
    lastConnected: 0,
    lastStatusAt: null,
    lastAuthChallenge: null,
    lastNotice: null,
    lastClosedMessage: null,
    lastError: null,
    lastPublishError: null,
  };
}

export function formatRelaySinceHint(sinceHint: number | null) {
  if (sinceHint === null) {
    return "未保存";
  }

  return `${sinceHint} (${formatCreatedAt(sinceHint)})`;
}
