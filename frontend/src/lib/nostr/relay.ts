import { normalizeHexPubkey } from "./pubkey";

export type RelayFilter = {
  kinds?: number[];
  authors?: string[];
  ids?: string[];
  "#p"?: string[];
  "#e"?: string[];
  "#a"?: string[];
  since?: number;
  until?: number;
  limit?: number;
};

export type RelayConnectionPhase =
  | "idle"
  | "connecting"
  | "subscribing"
  | "live"
  | "reconnecting"
  | "closed";

export type SubscriptionRole = "feed" | "profiles" | "notify" | "reaction";
type TrackedSubscriptionRole = SubscriptionRole | "temporary";

export type RelayStatus = {
  phase: RelayConnectionPhase;
  relayUrl: string;
  attempt: number;
  detail?: string;
  retryInMs?: number;
};

export type RelayDebugEventType =
  | "socket_open"
  | "socket_error"
  | "socket_close"
  | "recv_auth"
  | "send_req"
  | "send_event"
  | "send_close"
  | "recv_event"
  | "recv_eose"
  | "recv_notice"
  | "recv_closed"
  | "recv_ok"
  | "drop_message";

export type RelayDebugEvent = {
  type: RelayDebugEventType;
  relayUrl: string;
  at: number;
  detail?: string;
  readyState?: number;
  subscriptionId?: string;
  role?: TrackedSubscriptionRole | "unknown";
  closeCode?: number;
  closeReason?: string;
  payloadPreview?: string;
};

export type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

export type RelayEventContext = {
  role: SubscriptionRole;
  subscriptionId: string;
  event: NostrEvent;
};

export type RelayEoseContext = {
  role: SubscriptionRole;
  subscriptionId: string;
};

export type RelayClosedContext = {
  role: SubscriptionRole | "unknown";
  subscriptionId: string;
  message?: string;
};

export type RelayClientOptions = {
  relayUrl: string;
  buildFeedFilters: () => RelayFilter[] | Promise<RelayFilter[]>;
  onEvent: (context: RelayEventContext) => void | Promise<void>;
  onEose?: (context: RelayEoseContext) => void | Promise<void>;
  onAuthChallenge?: (challenge: string) => void;
  onNotice?: (message: string) => void;
  onClosed?: (context: RelayClosedContext) => void;
  onStatus?: (status: RelayStatus) => void;
  onError?: (message: string) => void;
  onDebug?: (event: RelayDebugEvent) => void;
};

type RelayMessage =
  | {
      type: "EVENT";
      subscriptionId: string;
      event: NostrEvent;
    }
  | {
      type: "EOSE";
      subscriptionId: string;
    }
  | {
      type: "AUTH";
      challenge: string;
    }
  | {
      type: "NOTICE";
      message: string;
    }
  | {
      type: "CLOSED";
      subscriptionId: string;
      message?: string;
    }
  | {
      type: "OK";
      eventId: string;
      accepted: boolean;
      message?: string;
    };

type RelayMessageInspection = {
  message: RelayMessage | null;
  diagnostic: Pick<RelayDebugEvent, "detail" | "payloadPreview"> | null;
};

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
export const MAX_RELAY_RECONNECT_ATTEMPTS = 3;
export const RELAY_RECONNECT_COOLDOWN_MS = 30_000;
const MAX_RELAY_MESSAGE_BYTES = 128 * 1024;
const MAX_EVENT_CONTENT_BYTES = 8 * 1024;
const MAX_EVENT_TAGS = 64;
const MAX_TAG_FIELDS_PER_TAG = 16;
const MAX_TAG_VALUE_BYTES = 256;
const MAX_REPLACEABLE_EVENT_CONTENT_BYTES = 64 * 1024;
const MAX_REPLACEABLE_EVENT_TAGS = 4_096;
const MAX_REPLACEABLE_TAG_FIELDS_PER_TAG = 8;
const MAX_REPLACEABLE_TAG_VALUE_BYTES = 2 * 1024;
export const MAX_PROFILE_AUTHORS_PER_REQ = 64;
export const RELAY_OPEN_TIMEOUT_MS = 10_000;
export const FEED_EOSE_TIMEOUT_MS = 15_000;
export const PROFILE_SUBSCRIPTION_TIMEOUT_MS = 8_000;
export const TEMPORARY_SUBSCRIPTION_TIMEOUT_MS = 8_000;
const PUBLISH_ACK_TIMEOUT_MS = 8_000;

type PublishAckWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

type TemporaryEventsSubscription = {
  mode: "events";
  filters: RelayFilter[];
  events: Map<string, NostrEvent>;
  latestEvent: null;
  requested: boolean;
  resolve: (value: NostrEvent[]) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

type TemporaryLatestSubscription = {
  mode: "latest";
  filters: RelayFilter[];
  events: Map<string, NostrEvent>;
  latestEvent: NostrEvent | null;
  requested: boolean;
  resolve: (value: NostrEvent | null) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

type TemporarySubscription =
  | TemporaryEventsSubscription
  | TemporaryLatestSubscription;

type TemporarySubscriptionStartArgs =
  | {
      mode: "events";
      filters: RelayFilter[];
      timeoutMs: number;
      resolve: (value: NostrEvent[]) => void;
      reject: (error: Error) => void;
    }
  | {
      mode: "latest";
      filters: RelayFilter[];
      timeoutMs: number;
      resolve: (value: NostrEvent | null) => void;
      reject: (error: Error) => void;
    };

export class RelayClient {
  private readonly options: RelayClientOptions;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private openTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptions = new Map<string, TrackedSubscriptionRole>();
  private feedSubscriptionFilters = new Map<string, RelayFilter[]>();
  private notifySubscriptionFilters = new Map<string, RelayFilter[]>();
  private reactionSubscriptionFilters = new Map<string, RelayFilter[]>();
  private profileSubscriptionAuthors = new Map<string, Set<string>>();
  private profileSubscriptionTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private feedEoseTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private temporarySubscriptions = new Map<string, TemporarySubscription>();
  private publishAckWaiters = new Map<string, PublishAckWaiter>();
  private currentFeedSubscriptionId: string | null = null;
  private pendingFeedEoseSubscriptionId: string | null = null;
  private currentNotifySubscriptionId: string | null = null;
  private currentReactionSubscriptionId: string | null = null;
  private configuredNotifyFilters: RelayFilter[] | null = null;
  private configuredNotifyFiltersKey = "[]";
  private configuredReactionFilters: RelayFilter[] | null = null;
  private configuredReactionFiltersKey = "[]";
  private attempt = 0;
  private manuallyClosed = false;

  constructor(options: RelayClientOptions) {
    this.options = options;
  }

  connect() {
    this.manuallyClosed = false;
    this.clearReconnectTimer();
    this.attempt = 0;
    this.openSocket();
  }

  setNotifyFilters(filters: RelayFilter[] | null) {
    const nextFilters = filters && filters.length > 0 ? cloneRelayFilters(filters) : null;
    const nextFiltersKey = JSON.stringify(nextFilters ?? []);

    if (nextFiltersKey === this.configuredNotifyFiltersKey) {
      return;
    }

    this.configuredNotifyFilters = nextFilters;
    this.configuredNotifyFiltersKey = nextFiltersKey;

    const socket = this.socket;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.rebuildNotifySubscription(socket);
  }

  setReactionFilters(filters: RelayFilter[] | null) {
    const nextFilters = filters && filters.length > 0 ? cloneRelayFilters(filters) : null;
    const nextFiltersKey = JSON.stringify(nextFilters ?? []);

    if (nextFiltersKey === this.configuredReactionFiltersKey) {
      return;
    }

    this.configuredReactionFilters = nextFilters;
    this.configuredReactionFiltersKey = nextFiltersKey;

    const socket = this.socket;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.rebuildReactionSubscription(socket);
  }

  requestProfiles(authors: string[]) {
    const socket = this.socket;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return 0;
    }

    const authorChunks = chunkProfileAuthors(authors);

    if (authorChunks.length === 0) {
      return 0;
    }

    let requestedAuthors = 0;

    for (const authorsChunk of authorChunks) {
      const subscriptionId = createSubscriptionId("profiles");
      this.subscriptions.set(subscriptionId, "profiles");
      this.trackProfileSubscription(subscriptionId, authorsChunk);

      socket.send(
        JSON.stringify([
          "REQ",
          subscriptionId,
          {
            kinds: [0],
            authors: authorsChunk,
          },
        ]),
      );
      this.emitDebug({
        type: "send_req",
        role: "profiles",
        subscriptionId,
        detail: `${authorsChunk.length} 件の pubkey で profiles を要求`,
        readyState: socket.readyState,
      });
      requestedAuthors += authorsChunk.length;
    }

    return requestedAuthors;
  }

  requestTemporaryEvents(
    filters: RelayFilter[],
    timeoutMs = TEMPORARY_SUBSCRIPTION_TIMEOUT_MS,
  ) {
    return new Promise<NostrEvent[]>((resolve, reject) => {
      this.startTemporarySubscription({
        mode: "events",
        filters,
        timeoutMs,
        resolve,
        reject,
      });
    });
  }

  requestTemporaryLatestEvent(
    filters: RelayFilter[],
    timeoutMs = TEMPORARY_SUBSCRIPTION_TIMEOUT_MS,
  ) {
    return new Promise<NostrEvent | null>((resolve, reject) => {
      this.startTemporarySubscription({
        mode: "latest",
        filters,
        timeoutMs,
        resolve,
        reject,
      });
    });
  }

  close() {
    this.manuallyClosed = true;
    this.clearReconnectTimer();
    this.clearOpenTimeout();
    this.clearFeedEoseTimeout();

    const socket = this.socket;
    this.socket = null;

    if (socket?.readyState === WebSocket.OPEN) {
      for (const subscriptionId of this.subscriptions.keys()) {
        socket.send(JSON.stringify(["CLOSE", subscriptionId]));
      }
    }

    this.rejectPendingTemporarySubscriptions(
      "temporary request aborted because the relay was closed",
    );
    this.rejectPendingPublishWaiters("publish aborted because the relay was closed");
    this.resetSubscriptionTracking();

    socket?.close();

    this.updateStatus({
      phase: "closed",
      relayUrl: this.options.relayUrl,
      attempt: this.attempt,
      detail: "subscription closed",
    });
  }

  publishEvent(event: NostrEvent) {
    const socket = this.socket;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("relay is not connected");
    }

    const payload = JSON.stringify([
      "EVENT",
      {
        id: event.id,
        pubkey: event.pubkey,
        created_at: event.created_at,
        kind: event.kind,
        tags: event.tags,
        content: event.content,
        sig: event.sig,
      },
    ]);

    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.publishAckWaiters.delete(event.id);
        reject(new Error("relay publish ack timed out"));
      }, PUBLISH_ACK_TIMEOUT_MS);

      this.publishAckWaiters.set(event.id, {
        resolve,
        reject,
        timeoutId,
      });

      try {
        socket.send(payload);
        this.emitDebug({
          type: "send_event",
          detail: `event ${event.id.slice(0, 12)} を publish`,
          readyState: socket.readyState,
        });
      } catch (error) {
        clearTimeout(timeoutId);
        this.publishAckWaiters.delete(event.id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private openSocket() {
    this.clearOpenTimeout();
    this.clearFeedEoseTimeout();

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    const socket = new WebSocket(this.options.relayUrl);
    this.socket = socket;
    this.startOpenTimeout(socket);

    this.updateStatus({
      phase: "connecting",
      relayUrl: this.options.relayUrl,
      attempt: this.attempt,
      detail: "relay connecting",
    });

    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.manuallyClosed) {
        return;
      }

      this.clearOpenTimeout();
      this.emitDebug({
        type: "socket_open",
        detail: "WebSocket opened",
        readyState: socket.readyState,
      });
      void this.handleOpen(socket);
    });

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || typeof event.data !== "string") {
        return;
      }

      void this.handleMessage(event.data);
    });

    socket.addEventListener("error", () => {
      if (this.socket !== socket || this.manuallyClosed) {
        return;
      }

      this.clearOpenTimeout();
      this.emitDebug({
        type: "socket_error",
        detail: "relay socket error",
        readyState: socket.readyState,
      });
      this.options.onError?.(`relay socket error: ${this.options.relayUrl}`);
      this.scheduleReconnect("relay error");
    });

    socket.addEventListener("close", (event) => {
      if (this.socket === socket) {
        this.socket = null;
      }

      this.clearOpenTimeout();
      this.emitDebug({
        type: "socket_close",
        detail: describeCloseEvent(event),
        readyState: socket.readyState,
        closeCode: closeEventCode(event),
        closeReason: closeEventReason(event),
      });

      if (this.manuallyClosed) {
        return;
      }

      this.scheduleReconnect(describeCloseEvent(event));
    });
  }

  private async handleOpen(socket: WebSocket) {
    try {
      const filters = await this.options.buildFeedFilters();

      if (
        this.socket !== socket ||
        this.manuallyClosed ||
        socket.readyState !== WebSocket.OPEN
      ) {
        return;
      }

      this.attempt = 0;

      const pendingTemporarySubscriptionIds = [
        ...this.temporarySubscriptions.keys(),
      ];

      this.subscriptions.clear();
      this.feedSubscriptionFilters.clear();
      this.notifySubscriptionFilters.clear();
      this.reactionSubscriptionFilters.clear();
      this.currentFeedSubscriptionId = null;
      this.currentNotifySubscriptionId = null;
      this.currentReactionSubscriptionId = null;

      for (const subscriptionId of pendingTemporarySubscriptionIds) {
        this.subscriptions.set(subscriptionId, "temporary");
      }

      if (!filters || filters.length === 0) {
        this.rebuildNotifySubscription(socket);
        this.rebuildReactionSubscription(socket);
        this.flushPendingTemporarySubscriptions(socket);
        this.updateStatus({
          phase: "live",
          relayUrl: this.options.relayUrl,
          attempt: this.attempt,
          detail: "connected without feed subscription",
        });
        return;
      }

      const subscriptionId = createSubscriptionId("feed");
      this.currentFeedSubscriptionId = subscriptionId;
      this.subscriptions.set(subscriptionId, "feed");
      this.feedSubscriptionFilters.set(subscriptionId, filters);
      this.startFeedEoseTimeout(subscriptionId);
      socket.send(JSON.stringify(["REQ", subscriptionId, ...filters]));
      this.emitDebug({
        type: "send_req",
        role: "feed",
        subscriptionId,
        detail: `sent ${filters.length} feed filters`,
        readyState: socket.readyState,
      });

      this.updateStatus({
        phase: "subscribing",
        relayUrl: this.options.relayUrl,
        attempt: this.attempt,
        detail: `subscribing to feed (${subscriptionId})`,
      });

      this.rebuildNotifySubscription(socket);
      this.rebuildReactionSubscription(socket);
      this.flushPendingTemporarySubscriptions(socket);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.onError?.(`feed filter の構築に失敗しました: ${message}`);
      this.scheduleReconnect("feed filter build failed");
    }
  }

  private async handleMessage(data: string) {
    let inspection = inspectRelayMessage(data);

    if (!inspection.message) {
      inspection =
        this.inspectTemporaryLatestRelayMessage(data)
        ?? this.inspectProfileRelayMessage(data)
        ?? inspection;
    }

    const { message, diagnostic } = inspection;

    if (!message) {
      this.emitDebug({
        type: "drop_message",
        ...(diagnostic ?? summarizeRawRelayMessage(data)),
      });
      return;
    }

    switch (message.type) {
      case "EVENT": {
        const role = this.subscriptions.get(message.subscriptionId);

        if (!role) {
          this.emitDebug({
            type: "drop_message",
            subscriptionId: message.subscriptionId,
            detail: "未登録 subscription の EVENT を破棄しました",
            payloadPreview: summarizePayloadPreview(data),
          });
          return;
        }

        if (role === "temporary") {
          const rejectionReason = this.getTemporaryEventRejectionReason(
            message.subscriptionId,
            message.event,
          );

          if (rejectionReason) {
            this.emitDebug({
              type: "drop_message",
              role,
              subscriptionId: message.subscriptionId,
              detail: rejectionReason,
              payloadPreview: summarizePayloadPreview(data),
            });
            return;
          }

          this.trackTemporaryEvent(message.subscriptionId, message.event);
          this.emitDebug({
            type: "recv_event",
            role,
            subscriptionId: message.subscriptionId,
          });
          return;
        }

        const rejectionReason = this.getEventRejectionReason(
          role,
          message.subscriptionId,
          message.event,
        );

        if (rejectionReason) {
          this.emitDebug({
            type: "drop_message",
            role,
            subscriptionId: message.subscriptionId,
            detail: rejectionReason,
            payloadPreview: summarizePayloadPreview(data),
          });
          return;
        }

        this.emitDebug({
          type: "recv_event",
          role,
          subscriptionId: message.subscriptionId,
        });

        await this.options.onEvent({
          role,
          subscriptionId: message.subscriptionId,
          event: message.event,
        });
        return;
      }

      case "EOSE": {
        const role = this.subscriptions.get(message.subscriptionId);

        if (!role) {
          this.emitDebug({
            type: "drop_message",
            subscriptionId: message.subscriptionId,
            detail: "未登録 subscription の EOSE を破棄しました",
            payloadPreview: summarizePayloadPreview(data),
          });
          return;
        }

        this.emitDebug({
          type: "recv_eose",
          role,
          subscriptionId: message.subscriptionId,
        });

        if (role === "temporary") {
          this.resolveTemporarySubscription(message.subscriptionId);
          return;
        }

        if (role === "feed") {
          if (
            !this.completeFeedInitialSync(
              message.subscriptionId,
              "initial sync complete, receiving live events",
            )
          ) {
            return;
          }
        }

        if (role === "profiles") {
          this.closeSubscription(message.subscriptionId);
        }

        await this.options.onEose?.({
          role,
          subscriptionId: message.subscriptionId,
        });
        return;
      }

      case "NOTICE":
        this.emitDebug({
          type: "recv_notice",
          detail: message.message,
        });
        this.options.onNotice?.(message.message);
        return;

      case "AUTH":
        this.emitDebug({
          type: "recv_auth",
          detail: "NIP-42 AUTH challenge を受信しました",
        });
        this.options.onAuthChallenge?.(message.challenge);
        return;

      case "CLOSED": {
        const role = this.subscriptions.get(message.subscriptionId) ?? "unknown";
        this.emitDebug({
          type: "recv_closed",
          role,
          subscriptionId: message.subscriptionId,
          detail: message.message,
        });

        if (role === "temporary") {
          this.resolveTemporarySubscription(message.subscriptionId);
          return;
        }

        this.clearProfileSubscriptionState(message.subscriptionId);
        this.subscriptions.delete(message.subscriptionId);
        this.feedSubscriptionFilters.delete(message.subscriptionId);
        this.notifySubscriptionFilters.delete(message.subscriptionId);
        this.reactionSubscriptionFilters.delete(message.subscriptionId);

        if (message.subscriptionId === this.currentFeedSubscriptionId) {
          this.clearFeedEoseTimeout();
          this.currentFeedSubscriptionId = null;
        }

        if (message.subscriptionId === this.currentNotifySubscriptionId) {
          this.currentNotifySubscriptionId = null;
        }

        if (message.subscriptionId === this.currentReactionSubscriptionId) {
          this.currentReactionSubscriptionId = null;
        }

        this.options.onClosed?.({
          role,
          subscriptionId: message.subscriptionId,
          message: message.message,
        });

        if (role === "feed") {
          this.scheduleReconnect(message.message ?? "feed closed");
        }
        return;
      }

      case "OK": {
        this.emitDebug({
          type: "recv_ok",
          detail: `${message.accepted ? "accepted" : "rejected"}: ${message.eventId}${
            message.message ? ` / ${message.message}` : ""
          }`,
        });

        const waiter = this.publishAckWaiters.get(message.eventId);

        if (!waiter) {
          return;
        }

        clearTimeout(waiter.timeoutId);
        this.publishAckWaiters.delete(message.eventId);

        if (message.accepted) {
          waiter.resolve();
          return;
        }

        waiter.reject(
          new Error(message.message ?? "relay rejected the publish"),
        );
        return;
      }
    }
  }

  private closeSubscription(subscriptionId: string) {
    const socket = this.socket;
    const temporarySubscription = this.temporarySubscriptions.get(subscriptionId);
    const shouldSendClose = temporarySubscription?.requested ?? true;
    this.clearProfileSubscriptionState(subscriptionId);
    this.clearTemporarySubscriptionState(subscriptionId);

    if (subscriptionId === this.currentFeedSubscriptionId) {
      this.clearFeedEoseTimeout();
    }

    if (shouldSendClose && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(["CLOSE", subscriptionId]));
      this.emitDebug({
        type: "send_close",
        role: this.subscriptions.get(subscriptionId),
        subscriptionId,
        detail: "subscription を CLOSE しました",
        readyState: socket.readyState,
      });
    }

    this.subscriptions.delete(subscriptionId);
    this.feedSubscriptionFilters.delete(subscriptionId);
    this.notifySubscriptionFilters.delete(subscriptionId);
    this.reactionSubscriptionFilters.delete(subscriptionId);

    if (subscriptionId === this.currentFeedSubscriptionId) {
      this.currentFeedSubscriptionId = null;
    }

    if (subscriptionId === this.currentNotifySubscriptionId) {
      this.currentNotifySubscriptionId = null;
    }

    if (subscriptionId === this.currentReactionSubscriptionId) {
      this.currentReactionSubscriptionId = null;
    }
  }

  private scheduleReconnect(reason: string) {
    if (this.manuallyClosed || this.reconnectTimer) {
      return;
    }

    this.clearOpenTimeout();
    this.clearFeedEoseTimeout();
    this.rejectPendingTemporarySubscriptions(
      `temporary request aborted because the relay is reconnecting: ${reason}`,
    );
    this.rejectPendingPublishWaiters(
      `publish aborted because the relay is reconnecting: ${reason}`,
    );
    this.resetSubscriptionTracking();
    const nextAttempt = this.attempt + 1;

    if (nextAttempt > MAX_RELAY_RECONNECT_ATTEMPTS) {
      this.updateStatus({
        phase: "reconnecting",
        relayUrl: this.options.relayUrl,
        attempt: this.attempt,
        retryInMs: RELAY_RECONNECT_COOLDOWN_MS,
        detail: `reconnect paused after ${MAX_RELAY_RECONNECT_ATTEMPTS} attempts: ${reason}`,
      });

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;

        if (this.manuallyClosed) {
          return;
        }

        this.attempt = 0;
        this.openSocket();
      }, RELAY_RECONNECT_COOLDOWN_MS);
      return;
    }

    this.attempt = nextAttempt;
    const retryInMs = backoffMs(this.attempt - 1);

    this.updateStatus({
      phase: "reconnecting",
      relayUrl: this.options.relayUrl,
      attempt: this.attempt,
      retryInMs,
      detail: `reconnecting: ${reason}`,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      if (this.manuallyClosed) {
        return;
      }

      this.openSocket();
    }, retryInMs);
  }

  private clearReconnectTimer() {
    if (!this.reconnectTimer) {
      return;
    }

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private startOpenTimeout(socket: WebSocket) {
    this.clearOpenTimeout();
    this.openTimeoutTimer = setTimeout(() => {
      if (
        this.socket !== socket ||
        this.manuallyClosed ||
        socket.readyState !== WebSocket.CONNECTING
      ) {
        return;
      }

      socket.close();
      this.scheduleReconnect("relay open timed out");
    }, RELAY_OPEN_TIMEOUT_MS);
  }

  private clearOpenTimeout() {
    if (!this.openTimeoutTimer) {
      return;
    }

    clearTimeout(this.openTimeoutTimer);
    this.openTimeoutTimer = null;
  }

  private updateStatus(status: RelayStatus) {
    this.options.onStatus?.(status);
  }

  private emitDebug(
    event: Omit<RelayDebugEvent, "relayUrl" | "at"> & {
      type: RelayDebugEventType;
    },
  ) {
    const payload: RelayDebugEvent = {
      relayUrl: this.options.relayUrl,
      at: Date.now(),
      ...event,
    };

    this.options.onDebug?.(payload);
    logRelayDebugEvent(payload);
  }

  private getEventRejectionReason(
    role: SubscriptionRole,
    subscriptionId: string,
    event: NostrEvent,
  ) {
    if (role === "feed") {
      const filters = this.feedSubscriptionFilters.get(subscriptionId);

      if (!filters || filters.length === 0) {
        return "feed filter が見つからない EVENT を破棄しました";
      }

      return matchesRelayFilters(event, filters)
        ? null
        : "feed filter と一致しない EVENT を破棄しました";
    }

    if (role === "notify") {
      const filters = this.notifySubscriptionFilters.get(subscriptionId);

      if (!filters || filters.length === 0) {
        return "notify filter が見つからない EVENT を破棄しました";
      }

      return matchesRelayFilters(event, filters)
        ? null
        : "notify filter と一致しない EVENT を破棄しました";
    }

    if (role === "reaction") {
      const filters = this.reactionSubscriptionFilters.get(subscriptionId);

      if (!filters || filters.length === 0) {
        return "reaction filter が見つからない EVENT を破棄しました";
      }

      return matchesRelayFilters(event, filters)
        ? null
        : "reaction filter と一致しない EVENT を破棄しました";
    }

    const expectedAuthors = this.profileSubscriptionAuthors.get(subscriptionId);

    if (event.kind !== 0 || !expectedAuthors?.has(event.pubkey)) {
      return "profiles 要求と一致しない EVENT を破棄しました";
    }

    return null;
  }

  private getTemporaryEventRejectionReason(
    subscriptionId: string,
    event: NostrEvent,
  ) {
    const subscription = this.temporarySubscriptions.get(subscriptionId);

    if (!subscription) {
      return "temporary subscription が見つからない EVENT を破棄しました";
    }

    return matchesRelayFilters(event, subscription.filters)
      ? null
      : "temporary filter と一致しない EVENT を破棄しました";
  }

  private rebuildNotifySubscription(socket: WebSocket) {
    const currentSubscriptionId = this.currentNotifySubscriptionId;

    if (currentSubscriptionId) {
      this.closeSubscription(currentSubscriptionId);
    }

    if (
      !this.configuredNotifyFilters
      || this.configuredNotifyFilters.length === 0
      || socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    const subscriptionId = createSubscriptionId("notify");
    const filters = cloneRelayFilters(this.configuredNotifyFilters);

    this.currentNotifySubscriptionId = subscriptionId;
    this.subscriptions.set(subscriptionId, "notify");
    this.notifySubscriptionFilters.set(subscriptionId, filters);
    socket.send(JSON.stringify(["REQ", subscriptionId, ...filters]));
    this.emitDebug({
      type: "send_req",
      role: "notify",
      subscriptionId,
      detail: `sent ${filters.length} notify filters`,
      readyState: socket.readyState,
    });
  }

  private rebuildReactionSubscription(socket: WebSocket) {
    const currentSubscriptionId = this.currentReactionSubscriptionId;

    if (currentSubscriptionId) {
      this.closeSubscription(currentSubscriptionId);
    }

    if (
      !this.configuredReactionFilters
      || this.configuredReactionFilters.length === 0
      || socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    const subscriptionId = createSubscriptionId("reaction");
    const filters = cloneRelayFilters(this.configuredReactionFilters);

    this.currentReactionSubscriptionId = subscriptionId;
    this.subscriptions.set(subscriptionId, "reaction");
    this.reactionSubscriptionFilters.set(subscriptionId, filters);
    socket.send(JSON.stringify(["REQ", subscriptionId, ...filters]));
    this.emitDebug({
      type: "send_req",
      role: "reaction",
      subscriptionId,
      detail: `sent ${filters.length} reaction filters`,
      readyState: socket.readyState,
    });
  }

  private inspectTemporaryLatestRelayMessage(
    data: string,
  ): RelayMessageInspection | null {
    try {
      const parsed = JSON.parse(data);

      if (!Array.isArray(parsed) || parsed.length === 0) {
        return null;
      }

      const [kind, first, second] = parsed;

      if (kind !== "EVENT" || typeof first !== "string") {
        return null;
      }

      if (this.subscriptions.get(first) !== "temporary") {
        return null;
      }

      const subscription = this.temporarySubscriptions.get(first);

      if (!subscription || subscription.mode !== "latest") {
        return null;
      }

      const parsedEvent = parseReplaceableNostrEvent(second);

      if (!parsedEvent.event) {
        return null;
      }

      return {
        message: {
          type: "EVENT",
          subscriptionId: first,
          event: parsedEvent.event,
        },
        diagnostic: null,
      };
    } catch {
      return null;
    }
  }

  private inspectProfileRelayMessage(
    data: string,
  ): RelayMessageInspection | null {
    try {
      const parsed = JSON.parse(data);

      if (!Array.isArray(parsed) || parsed.length === 0) {
        return null;
      }

      const [kind, first, second] = parsed;

      if (kind !== "EVENT" || typeof first !== "string") {
        return null;
      }

      if (this.subscriptions.get(first) !== "profiles") {
        return null;
      }

      const parsedEvent = parseReplaceableNostrEvent(second);

      if (!parsedEvent.event) {
        return null;
      }

      return {
        message: {
          type: "EVENT",
          subscriptionId: first,
          event: parsedEvent.event,
        },
        diagnostic: null,
      };
    } catch {
      return null;
    }
  }

  private trackTemporaryEvent(subscriptionId: string, event: NostrEvent) {
    const subscription = this.temporarySubscriptions.get(subscriptionId);

    if (!subscription) {
      return;
    }

    if (subscription.mode === "latest") {
      if (
        !subscription.latestEvent
        || event.created_at >= subscription.latestEvent.created_at
      ) {
        subscription.latestEvent = event;
      }
      return;
    }

    subscription.events.set(event.id, event);
  }

  private startTemporarySubscription(args: {
    mode: "events";
    filters: RelayFilter[];
    timeoutMs: number;
    resolve: (value: NostrEvent[]) => void;
    reject: (error: Error) => void;
  }): void;
  private startTemporarySubscription(args: {
    mode: "latest";
    filters: RelayFilter[];
    timeoutMs: number;
    resolve: (value: NostrEvent | null) => void;
    reject: (error: Error) => void;
  }): void;
  private startTemporarySubscription(args: TemporarySubscriptionStartArgs) {
    const filters = args.filters.filter((filter) => Object.keys(filter).length > 0);

    if (filters.length === 0) {
      if (args.mode === "latest") {
        args.resolve(null);
      } else {
        args.resolve([]);
      }
      return;
    }

    const subscriptionId = createSubscriptionId("temporary");
    const timeoutId = setTimeout(() => {
      this.rejectTemporarySubscription(
        subscriptionId,
        new Error("temporary relay request timed out"),
      );
    }, args.timeoutMs);

    this.subscriptions.set(subscriptionId, "temporary");
    if (args.mode === "latest") {
      this.temporarySubscriptions.set(subscriptionId, {
        mode: "latest",
        filters,
        events: new Map(),
        latestEvent: null,
        requested: false,
        resolve: args.resolve,
        reject: args.reject,
        timeoutId,
      });
    } else {
      this.temporarySubscriptions.set(subscriptionId, {
        mode: "events",
        filters,
        events: new Map(),
        latestEvent: null,
        requested: false,
        resolve: args.resolve,
        reject: args.reject,
        timeoutId,
      });
    }

    const socket = this.socket;

    if (!socket) {
      if (this.reconnectTimer) {
        return;
      }

      this.rejectTemporarySubscription(
        subscriptionId,
        new Error("relay is not connected"),
      );
      return;
    }

    if (socket.readyState === WebSocket.CONNECTING) {
      return;
    }

    if (socket.readyState !== WebSocket.OPEN) {
      if (this.reconnectTimer) {
        return;
      }

      this.rejectTemporarySubscription(
        subscriptionId,
        new Error("relay is not connected"),
      );
      return;
    }

    this.sendTemporarySubscriptionRequest(subscriptionId, socket);
  }

  private flushPendingTemporarySubscriptions(socket: WebSocket) {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    for (const subscriptionId of this.temporarySubscriptions.keys()) {
      this.sendTemporarySubscriptionRequest(subscriptionId, socket);
    }
  }

  private sendTemporarySubscriptionRequest(
    subscriptionId: string,
    socket: WebSocket,
  ) {
    const subscription = this.temporarySubscriptions.get(subscriptionId);

    if (!subscription || subscription.requested || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    subscription.requested = true;
    socket.send(JSON.stringify(["REQ", subscriptionId, ...subscription.filters]));
    this.emitDebug({
      type: "send_req",
      role: "temporary",
      subscriptionId,
      detail: `sent ${subscription.filters.length} temporary filters`,
      readyState: socket.readyState,
    });
  }

  private resolveTemporarySubscription(subscriptionId: string) {
    const subscription = this.temporarySubscriptions.get(subscriptionId);

    if (!subscription) {
      return;
    }

    this.closeSubscription(subscriptionId);

    if (subscription.mode === "latest") {
      subscription.resolve(subscription.latestEvent);
      return;
    }

    subscription.resolve([...subscription.events.values()]);
  }

  private rejectTemporarySubscription(subscriptionId: string, error: Error) {
    const subscription = this.temporarySubscriptions.get(subscriptionId);

    if (!subscription) {
      return;
    }

    this.closeSubscription(subscriptionId);
    subscription.reject(error);
  }

  private startFeedEoseTimeout(subscriptionId: string) {
    this.clearFeedEoseTimeout();
    this.pendingFeedEoseSubscriptionId = subscriptionId;
    this.feedEoseTimeoutTimer = setTimeout(() => {
      void this.handleFeedEoseTimeout(subscriptionId);
    }, FEED_EOSE_TIMEOUT_MS);
  }

  private clearFeedEoseTimeout() {
    if (this.feedEoseTimeoutTimer) {
      clearTimeout(this.feedEoseTimeoutTimer);
      this.feedEoseTimeoutTimer = null;
    }

    this.pendingFeedEoseSubscriptionId = null;
  }

  private completeFeedInitialSync(subscriptionId: string, detail: string) {
    if (
      this.currentFeedSubscriptionId !== subscriptionId ||
      this.pendingFeedEoseSubscriptionId !== subscriptionId
    ) {
      return false;
    }

    this.clearFeedEoseTimeout();
    this.attempt = 0;
    this.updateStatus({
      phase: "live",
      relayUrl: this.options.relayUrl,
      attempt: this.attempt,
      detail,
    });
    return true;
  }

  private async handleFeedEoseTimeout(subscriptionId: string) {
    if (
      !this.completeFeedInitialSync(
        subscriptionId,
        "initial sync timed out, receiving live events",
      )
    ) {
      return;
    }

    await this.options.onEose?.({
      role: "feed",
      subscriptionId,
    });
  }

  private trackProfileSubscription(subscriptionId: string, authors: string[]) {
    this.profileSubscriptionAuthors.set(subscriptionId, new Set(authors));

    const timeoutId = setTimeout(() => {
      if (this.subscriptions.get(subscriptionId) !== "profiles") {
        return;
      }

      this.closeSubscription(subscriptionId);
    }, PROFILE_SUBSCRIPTION_TIMEOUT_MS);

    this.profileSubscriptionTimers.set(subscriptionId, timeoutId);
  }

  private clearProfileSubscriptionState(subscriptionId: string) {
    const timeoutId = this.profileSubscriptionTimers.get(subscriptionId);

    if (timeoutId) {
      clearTimeout(timeoutId);
      this.profileSubscriptionTimers.delete(subscriptionId);
    }

    this.profileSubscriptionAuthors.delete(subscriptionId);
  }

  private clearTemporarySubscriptionState(subscriptionId: string) {
    const subscription = this.temporarySubscriptions.get(subscriptionId);

    if (!subscription) {
      return;
    }

    clearTimeout(subscription.timeoutId);
    this.temporarySubscriptions.delete(subscriptionId);
  }

  private resetSubscriptionTracking() {
    this.clearFeedEoseTimeout();

    for (const timeoutId of this.profileSubscriptionTimers.values()) {
      clearTimeout(timeoutId);
    }

    this.profileSubscriptionTimers.clear();
    this.profileSubscriptionAuthors.clear();
    for (const subscription of this.temporarySubscriptions.values()) {
      clearTimeout(subscription.timeoutId);
    }
    this.temporarySubscriptions.clear();
    this.feedSubscriptionFilters.clear();
    this.notifySubscriptionFilters.clear();
    this.reactionSubscriptionFilters.clear();
    this.subscriptions.clear();
    this.currentFeedSubscriptionId = null;
    this.currentNotifySubscriptionId = null;
    this.currentReactionSubscriptionId = null;
  }

  private rejectPendingTemporarySubscriptions(message: string) {
    for (const [subscriptionId, subscription] of this.temporarySubscriptions.entries()) {
      clearTimeout(subscription.timeoutId);
      subscription.reject(new Error(message));
      this.temporarySubscriptions.delete(subscriptionId);
      this.subscriptions.delete(subscriptionId);
    }
  }

  private rejectPendingPublishWaiters(message: string) {
    for (const [eventId, waiter] of this.publishAckWaiters.entries()) {
      clearTimeout(waiter.timeoutId);
      waiter.reject(new Error(message));
      this.publishAckWaiters.delete(eventId);
    }
  }
}

export function backoffMs(attempt: number) {
  const exponential = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
  const jitter = Math.random() * exponential * 0.3;
  return Math.round(exponential + jitter);
}

export function parseRelayMessage(data: string): RelayMessage | null {
  return inspectRelayMessage(data).message;
}

export function matchesRelayFilters(event: NostrEvent, filters: RelayFilter[]) {
  if (filters.length === 0) {
    return false;
  }

  return filters.some((filter) => matchesRelayFilter(event, filter));
}

export function matchesRelayFilter(event: NostrEvent, filter: RelayFilter) {
  if (filter.kinds && filter.kinds.length > 0 && !filter.kinds.includes(event.kind)) {
    return false;
  }

  const normalizedPubkey = normalizeHexPubkey(event.pubkey);

  if (
    filter.authors &&
    filter.authors.length > 0 &&
    !filter.authors.some((author) => normalizeHexPubkey(author) === normalizedPubkey)
  ) {
    return false;
  }

  if (
    filter.ids &&
    filter.ids.length > 0 &&
    !filter.ids.some((eventId) => eventId.trim().toLowerCase() === event.id.toLowerCase())
  ) {
    return false;
  }

  if (
    filter["#p"] &&
    filter["#p"].length > 0 &&
    !matchesEventTagFilter(event, "p", filter["#p"], normalizeTaggedPubkey)
  ) {
    return false;
  }

  if (
    filter["#e"] &&
    filter["#e"].length > 0 &&
    !matchesEventTagFilter(event, "e", filter["#e"], normalizeEventId)
  ) {
    return false;
  }

  if (
    filter["#a"] &&
    filter["#a"].length > 0 &&
    !matchesEventTagFilter(event, "a", filter["#a"], normalizeTagValue)
  ) {
    return false;
  }

  if (filter.since !== undefined && event.created_at < filter.since) {
    return false;
  }

  if (filter.until !== undefined && event.created_at > filter.until) {
    return false;
  }

  return true;
}

function matchesEventTagFilter(
  event: NostrEvent,
  tagName: string,
  expectedValues: string[],
  normalizeValue: (value: string) => string | null,
) {
  const normalizedExpectedValues = expectedValues
    .map(normalizeValue)
    .filter((value): value is string => value !== null);

  if (normalizedExpectedValues.length === 0) {
    return false;
  }

  return event.tags.some((tag) => {
    if (tag[0] !== tagName) {
      return false;
    }

    const taggedValue = normalizeValue(tag[1] ?? "");
    return taggedValue ? normalizedExpectedValues.includes(taggedValue) : false;
  });
}

function normalizeTaggedPubkey(value: string) {
  return normalizeHexPubkey(value);
}

function normalizeEventId(value: string) {
  const normalizedValue = value.trim().toLowerCase();
  return normalizedValue.length === 64 && /^[0-9a-f]+$/u.test(normalizedValue)
    ? normalizedValue
    : null;
}

function normalizeTagValue(value: string) {
  const normalizedValue = value.trim();
  return normalizedValue === "" ? null : normalizedValue;
}

export function inspectRelayMessage(data: string): RelayMessageInspection {
  if (utf8ByteLength(data) > MAX_RELAY_MESSAGE_BYTES) {
    return buildRelayMessageDiagnostic(
      data,
      `relay message がローカル上限 ${MAX_RELAY_MESSAGE_BYTES} bytes を超えました`,
    );
  }

  try {
    const parsed = JSON.parse(data);

    if (!Array.isArray(parsed) || parsed.length === 0) {
      return buildRelayMessageDiagnostic(
        data,
        "relay message の envelope 形式が不正です",
      );
    }

    const [kind, first, second] = parsed;

    if (kind === "EVENT" && typeof first === "string") {
      const parsedEvent = parseNostrEvent(second);

      if (!parsedEvent.event) {
        return buildRelayMessageDiagnostic(data, parsedEvent.detail);
      }

      return {
        message: {
          type: "EVENT",
          subscriptionId: first,
          event: parsedEvent.event,
        },
        diagnostic: null,
      };
    }

    if (kind === "EOSE" && typeof first === "string") {
      return {
        message: {
          type: "EOSE",
          subscriptionId: first,
        },
        diagnostic: null,
      };
    }

    if (kind === "NOTICE" && typeof first === "string") {
      return {
        message: {
          type: "NOTICE",
          message: first,
        },
        diagnostic: null,
      };
    }

    if (kind === "AUTH" && typeof first === "string") {
      return {
        message: {
          type: "AUTH",
          challenge: first,
        },
        diagnostic: null,
      };
    }

    if (kind === "CLOSED" && typeof first === "string") {
      return {
        message: {
          type: "CLOSED",
          subscriptionId: first,
          message: typeof second === "string" ? second : undefined,
        },
        diagnostic: null,
      };
    }

    if (
      kind === "OK" &&
      typeof first === "string" &&
      typeof second === "boolean"
    ) {
      return {
        message: {
          type: "OK",
          eventId: first,
          accepted: second,
          message: typeof parsed[3] === "string" ? parsed[3] : undefined,
        },
        diagnostic: null,
      };
    }

    if (typeof kind === "string") {
      return buildRelayMessageDiagnostic(
        data,
        `未対応 envelope を破棄しました: ${kind}`,
      );
    }

    return buildRelayMessageDiagnostic(
      data,
      "relay message の envelope 形式が不正です",
    );
  } catch {
    return buildRelayMessageDiagnostic(
      data,
      "JSON として解釈できない relay message を破棄しました",
    );
  }
}

function parseNostrEvent(value: unknown): {
  event: NostrEvent | null;
  detail: string;
} {
  return parseNostrEventWithLimits(value, {
    maxContentBytes: MAX_EVENT_CONTENT_BYTES,
    maxTags: MAX_EVENT_TAGS,
    maxTagFieldsPerTag: MAX_TAG_FIELDS_PER_TAG,
    maxTagValueBytes: MAX_TAG_VALUE_BYTES,
    normalizePubkey: false,
  });
}

function parseReplaceableNostrEvent(value: unknown): {
  event: NostrEvent | null;
  detail: string;
} {
  return parseNostrEventWithLimits(value, {
    maxContentBytes: MAX_REPLACEABLE_EVENT_CONTENT_BYTES,
    maxTags: MAX_REPLACEABLE_EVENT_TAGS,
    maxTagFieldsPerTag: MAX_REPLACEABLE_TAG_FIELDS_PER_TAG,
    maxTagValueBytes: MAX_REPLACEABLE_TAG_VALUE_BYTES,
    normalizePubkey: true,
  });
}

function parseNostrEventWithLimits(
  value: unknown,
  limits: {
    maxContentBytes: number;
    maxTags: number;
    maxTagFieldsPerTag: number;
    maxTagValueBytes: number;
    normalizePubkey: boolean;
  },
): {
  event: NostrEvent | null;
  detail: string;
} {
  if (!isRecord(value)) {
    return {
      event: null,
      detail: "EVENT payload の形式が不正です",
    };
  }

  const id = value.id;
  const pubkey = value.pubkey;
  const createdAt = value.created_at;
  const kind = value.kind;
  const tags = value.tags;
  const content = value.content;
  const sig = value.sig;

  if (
    typeof id !== "string" ||
    typeof pubkey !== "string" ||
    typeof createdAt !== "number" ||
    !Number.isInteger(createdAt) ||
    createdAt < 0 ||
    typeof kind !== "number" ||
    !Number.isInteger(kind) ||
    kind < 0 ||
    typeof content !== "string" ||
    typeof sig !== "string"
  ) {
    return {
      event: null,
      detail: "EVENT の必須フィールド形式が不正です",
    };
  }

  if (!Array.isArray(tags)) {
    return {
      event: null,
      detail: "EVENT tags の形式が不正です",
    };
  }

  if (utf8ByteLength(content) > limits.maxContentBytes) {
    return {
      event: null,
      detail: `EVENT content がローカル上限 ${limits.maxContentBytes} bytes を超えました`,
    };
  }

  if (tags.length > limits.maxTags) {
    return {
      event: null,
      detail: `EVENT tags 数がローカル上限 ${limits.maxTags} を超えました`,
    };
  }

  const normalizedTags: string[][] = [];

  for (const tag of tags) {
    if (!Array.isArray(tag)) {
      return {
        event: null,
        detail: "EVENT tag の形式が不正です",
      };
    }

    if (tag.length > limits.maxTagFieldsPerTag) {
      return {
        event: null,
        detail: `EVENT tag 配列の要素数がローカル上限 ${limits.maxTagFieldsPerTag} を超えました`,
      };
    }

    const normalizedTag: string[] = [];

    for (const item of tag) {
      if (typeof item !== "string") {
        return {
          event: null,
          detail: "EVENT tag 値の形式が不正です",
        };
      }

      if (utf8ByteLength(item) > limits.maxTagValueBytes) {
        return {
          event: null,
          detail: `EVENT tag 値がローカル上限 ${limits.maxTagValueBytes} bytes を超えました`,
        };
      }

      normalizedTag.push(item);
    }

    normalizedTags.push(normalizedTag);
  }

  return {
    event: {
      id,
      pubkey: limits.normalizePubkey ? normalizeHexPubkey(pubkey) : pubkey,
      created_at: createdAt,
      kind,
      tags: normalizedTags,
      content,
      sig,
    },
    detail: "",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function chunkProfileAuthors(authors: string[]) {
  return chunkStrings(uniqueStrings(authors), MAX_PROFILE_AUTHORS_PER_REQ);
}

function cloneRelayFilters(filters: RelayFilter[]) {
  return filters.map((filter) => ({
    ...filter,
    kinds: filter.kinds ? [...filter.kinds] : undefined,
    authors: filter.authors ? [...filter.authors] : undefined,
    ids: filter.ids ? [...filter.ids] : undefined,
    "#p": filter["#p"] ? [...filter["#p"]] : undefined,
    "#e": filter["#e"] ? [...filter["#e"]] : undefined,
    "#a": filter["#a"] ? [...filter["#a"]] : undefined,
  }));
}

function createSubscriptionId(role: TrackedSubscriptionRole) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${role}-${crypto.randomUUID()}`;
  }

  return `${role}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function chunkStrings(values: string[], chunkSize: number) {
  const chunks: string[][] = [];

  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }

  return chunks;
}

function logRelayDebugEvent(event: RelayDebugEvent) {
  if (!isRelayDebugConsoleEnabled() || event.type === "recv_event") {
    return;
  }

  const label = `[relay:${event.type}]`;

  if (
    event.type === "socket_error" ||
    event.type === "socket_close" ||
    event.type === "recv_notice" ||
    event.type === "recv_closed" ||
    event.type === "drop_message"
  ) {
    console.warn(label, event);
    return;
  }

  console.info(label, event);
}

function isRelayDebugConsoleEnabled() {
  return import.meta.env.DEV && import.meta.env.MODE !== "test";
}

function summarizeRawRelayMessage(data: string): Pick<
  RelayDebugEvent,
  "detail" | "payloadPreview"
> {
  const payloadPreview = summarizePayloadPreview(data);

  try {
    const parsed = JSON.parse(data);

    if (Array.isArray(parsed) && typeof parsed[0] === "string") {
      return {
        detail: `未対応または不正な relay message を破棄しました: ${parsed[0]}`,
        payloadPreview,
      };
    }
  } catch {
    return {
      detail: "JSON として解釈できない relay message を破棄しました",
      payloadPreview,
    };
  }

  return {
    detail: "relay message を解釈できませんでした",
    payloadPreview,
  };
}

function buildRelayMessageDiagnostic(
  data: string,
  detail: string,
): RelayMessageInspection {
  return {
    message: null,
    diagnostic: {
      detail,
      payloadPreview: summarizePayloadPreview(data),
    },
  };
}

function summarizePayloadPreview(data: string) {
  const normalized = data.replace(/\s+/g, " ").trim();

  if (normalized.length <= 200) {
    return normalized;
  }

  return `${normalized.slice(0, 200)}…`;
}

function closeEventCode(event: unknown) {
  return isCloseEventLike(event) ? event.code : undefined;
}

function closeEventReason(event: unknown) {
  return isCloseEventLike(event) ? event.reason : undefined;
}

function describeCloseEvent(event: unknown) {
  if (!isCloseEventLike(event)) {
    return "relay close";
  }

  const parts = [`relay close code=${event.code}`];

  if (event.reason) {
    parts.push(`reason=${event.reason}`);
  }

  if (event.wasClean === false) {
    parts.push("unclean");
  }

  return parts.join(" / ");
}

function isCloseEventLike(
  event: unknown,
): event is { code: number; reason: string; wasClean?: boolean } {
  return (
    typeof event === "object" &&
    event !== null &&
    typeof (event as { code?: unknown }).code === "number" &&
    typeof (event as { reason?: unknown }).reason === "string"
  );
}

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).length;
}
