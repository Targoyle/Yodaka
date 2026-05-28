export type TimelineView = "relay" | "follow" | "account";

export type AuxiliaryLoadState = "idle" | "loading" | "ready" | "error";

export type RelayDiagnosticState = {
  sinceHint: number | null;
  lastConnected: number;
  lastStatusAt: number | null;
  lastNotice: string | null;
  lastClosedMessage: string | null;
  lastError: string | null;
  lastPublishError: string | null;
};
