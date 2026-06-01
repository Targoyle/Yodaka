export type TimelineView = "relay" | "follow" | "notify" | "reaction" | "account";

export type AuxiliaryLoadState =
  | "idle"
  | "waiting"
  | "loading"
  | "ready"
  | "listening"
  | "error";

export type AuxiliaryTimelineDiagnostic = {
  label: string;
  loadState: AuxiliaryLoadState;
  relayCount: number;
  readyReadRelayCount: number;
  itemCount: number;
  summary: string | null;
  lastFetchedAt: number | null;
  lastEventAt: number | null;
  liveEventCount: number | null;
  error: string | null;
};

export type RelayDiagnosticState = {
  sinceHint: number | null;
  lastConnected: number;
  lastStatusAt: number | null;
  lastAuthChallenge: string | null;
  lastNotice: string | null;
  lastClosedMessage: string | null;
  lastError: string | null;
  lastPublishError: string | null;
};
