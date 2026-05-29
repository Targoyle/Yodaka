export type TimelineView = "relay" | "follow" | "notify" | "reaction" | "account";

export type AuxiliaryLoadState = "idle" | "waiting" | "loading" | "ready" | "error";

export type RelayDiagnosticState = {
  sinceHint: number | null;
  lastConnected: number;
  lastStatusAt: number | null;
  lastNotice: string | null;
  lastClosedMessage: string | null;
  lastError: string | null;
  lastPublishError: string | null;
};
