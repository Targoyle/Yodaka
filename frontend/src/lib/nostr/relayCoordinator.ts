import {
  RelayClient,
  type NostrEvent,
  type RelayClosedContext,
  type RelayDebugEvent,
  type RelayEoseContext,
  type RelayEventContext,
  type RelayFilter,
  type RelayStatus,
} from "./relay";
import { formatRelayAccessMessage } from "./relayAuth";

export type RelayCoordinatorPhase =
  | "idle"
  | "paused"
  | "connecting"
  | "subscribing"
  | "live"
  | "partial"
  | "degraded"
  | "offline"
  | "closed";

export type RelayCoordinatorStatus = {
  phase: RelayCoordinatorPhase;
  relayCount: number;
  readyRelayCount: number;
  liveRelayCount: number;
  relayStatuses: RelayStatus[];
  detail?: string;
};

export type RelayCoordinatorEventContext = RelayEventContext & {
  relayUrl: string;
};

export type RelayCoordinatorEoseContext = RelayEoseContext & {
  relayUrl: string;
};

export type RelayCoordinatorClosedContext = RelayClosedContext & {
  relayUrl: string;
};

export type RelayPublishResult = {
  acceptedRelayUrls: string[];
  rejectedRelayUrls: string[];
  errors: Array<{
    relayUrl: string;
    message: string;
  }>;
};

export class RelayPublishError extends Error {
  readonly rejectedRelayUrls: string[];
  readonly errors: RelayPublishResult["errors"];

  constructor(args: {
    rejectedRelayUrls: string[];
    errors: RelayPublishResult["errors"];
  }) {
    super(buildRelayPublishErrorMessage(args.errors));
    this.name = "RelayPublishError";
    Object.setPrototypeOf(this, RelayPublishError.prototype);
    this.rejectedRelayUrls = args.rejectedRelayUrls;
    this.errors = args.errors;
  }
}

export type RelayCoordinatorOptions = {
  relayUrls: string[];
  profileRelayUrls?: string[];
  publishRelayUrls?: string[];
  buildFeedFilters: (relayUrl: string) => RelayFilter[] | Promise<RelayFilter[]>;
  onEvent: (
    context: RelayCoordinatorEventContext,
  ) => void | Promise<void>;
  onEose?: (
    context: RelayCoordinatorEoseContext,
  ) => void | Promise<void>;
  onAuthChallenge?: (args: { relayUrl: string; challenge: string }) => void;
  onClosed?: (context: RelayCoordinatorClosedContext) => void;
  onStatus?: (status: RelayCoordinatorStatus) => void;
  onRelayStatus?: (status: RelayStatus) => void;
  onNotice?: (message: string) => void;
  onError?: (message: string) => void;
  onDebug?: (event: RelayDebugEvent) => void;
};

export class RelayCoordinator {
  private readonly options: RelayCoordinatorOptions;
  private readonly relayUrls: string[];
  private readonly profileRelayUrls: string[];
  private readonly publishRelayUrls: string[];
  private readonly clients = new Map<string, RelayClient>();
  private readonly relayStatuses = new Map<string, RelayStatus>();

  constructor(options: RelayCoordinatorOptions) {
    this.options = options;
    this.relayUrls = uniqueRelayUrls(options.relayUrls);
    this.profileRelayUrls = selectConfiguredRelayUrls(
      this.relayUrls,
      options.profileRelayUrls ?? this.relayUrls,
    );
    this.publishRelayUrls = selectConfiguredRelayUrls(
      this.relayUrls,
      options.publishRelayUrls ?? this.relayUrls,
    );
  }

  connect() {
    this.closeClients();

    if (this.relayUrls.length === 0) {
      this.emitStatus({
        phase: "offline",
        relayCount: 0,
        readyRelayCount: 0,
        liveRelayCount: 0,
        relayStatuses: [],
        detail: "no relays configured",
      });
      return;
    }

    for (const relayUrl of this.relayUrls) {
      const client = new RelayClient({
        relayUrl,
        buildFeedFilters: () => this.options.buildFeedFilters(relayUrl),
        onEvent: (context) =>
          this.options.onEvent({
            ...context,
            relayUrl,
          }),
        onEose: (context) =>
          this.options.onEose?.({
            ...context,
            relayUrl,
          }),
        onAuthChallenge: (challenge) =>
          this.options.onAuthChallenge?.({
            relayUrl,
            challenge,
          }),
        onClosed: (context) =>
          this.options.onClosed?.({
            ...context,
            relayUrl,
          }),
        onNotice: this.options.onNotice,
        onStatus: (status) => {
          this.relayStatuses.set(relayUrl, status);
          this.options.onRelayStatus?.(status);
          this.emitStatus(aggregateRelayStatuses(this.relayUrls, this.relayStatuses));
        },
        onError: this.options.onError,
        onDebug: this.options.onDebug,
      });

      this.clients.set(relayUrl, client);
      this.relayStatuses.set(relayUrl, buildRelayStatus("idle", relayUrl));
      client.connect();
    }

    this.emitStatus(aggregateRelayStatuses(this.relayUrls, this.relayStatuses));
  }

  requestProfiles(authors: string[]) {
    let requested = 0;

    for (const relayUrl of this.profileRelayUrls) {
      const client = this.clients.get(relayUrl);

      if (!client) {
        continue;
      }

      requested += client.requestProfiles(authors);
    }

    return requested;
  }

  requestTemporaryEvents(
    relayUrl: string,
    filters: RelayFilter[],
    timeoutMs?: number,
  ) {
    const client = this.clients.get(relayUrl);

    if (!client) {
      throw new Error("relay client が初期化されていません");
    }

    return client.requestTemporaryEvents(filters, timeoutMs);
  }

  requestTemporaryLatestEvent(
    relayUrl: string,
    filters: RelayFilter[],
    timeoutMs?: number,
  ) {
    const client = this.clients.get(relayUrl);

    if (!client) {
      throw new Error("relay client が初期化されていません");
    }

    return client.requestTemporaryLatestEvent(filters, timeoutMs);
  }

  async publishEvent(event: NostrEvent): Promise<RelayPublishResult> {
    if (this.publishRelayUrls.length === 0) {
      throw new Error("write relay が設定されていません");
    }

    const settled = await Promise.allSettled(
      this.publishRelayUrls.map(async (relayUrl) => {
        const client = this.clients.get(relayUrl);

        if (!client) {
          throw new Error("relay client が初期化されていません");
        }

        await client.publishEvent(event);
        return relayUrl;
      }),
    );

    const acceptedRelayUrls: string[] = [];
    const rejectedRelayUrls: string[] = [];
    const errors: RelayPublishResult["errors"] = [];

    settled.forEach((result, index) => {
      const relayUrl = this.publishRelayUrls[index];

      if (result.status === "fulfilled") {
        acceptedRelayUrls.push(result.value);
        return;
      }

      rejectedRelayUrls.push(relayUrl);
      errors.push({
        relayUrl,
        message:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      });
    });

    if (acceptedRelayUrls.length === 0) {
      throw new RelayPublishError({
        rejectedRelayUrls,
        errors,
      });
    }

    return {
      acceptedRelayUrls,
      rejectedRelayUrls,
      errors,
    };
  }

  close() {
    this.closeClients();

    const relayStatuses = this.relayUrls.map((relayUrl) => ({
      phase: "closed",
      relayUrl,
      attempt: this.relayStatuses.get(relayUrl)?.attempt ?? 0,
      detail: "subscription closed",
    } satisfies RelayStatus));

    this.relayStatuses.clear();
    for (const status of relayStatuses) {
      this.relayStatuses.set(status.relayUrl, status);
    }

    this.emitStatus({
      phase: "closed",
      relayCount: relayStatuses.length,
      readyRelayCount: 0,
      liveRelayCount: 0,
      relayStatuses,
      detail: relayStatuses.length > 0 ? "subscription closed" : "no relays configured",
    });
  }

  private closeClients() {
    for (const client of this.clients.values()) {
      client.close();
    }

    this.clients.clear();
  }

  private emitStatus(status: RelayCoordinatorStatus) {
    this.options.onStatus?.(status);
  }
}

function aggregateRelayStatuses(
  relayUrls: string[],
  relayStatusMap: ReadonlyMap<string, RelayStatus>,
): RelayCoordinatorStatus {
  const relayStatuses = relayUrls.map(
    (relayUrl) =>
      relayStatusMap.get(relayUrl) ?? buildRelayStatus("idle", relayUrl),
  );
  const relayCount = relayStatuses.length;
  const liveRelayCount = countRelayPhases(relayStatuses, "live");
  const readyRelayCount = liveRelayCount;
  const connectingCount = countRelayPhases(relayStatuses, "connecting");
  const subscribingCount = countRelayPhases(relayStatuses, "subscribing");
  const reconnectingCount = countRelayPhases(relayStatuses, "reconnecting");
  const closedCount = countRelayPhases(relayStatuses, "closed");

  if (relayCount === 0) {
    return {
      phase: "offline",
      relayCount,
      readyRelayCount,
      liveRelayCount,
      relayStatuses,
      detail: "no relays configured",
    };
  }

  if (liveRelayCount === relayCount) {
    return {
      phase: "live",
      relayCount,
      readyRelayCount,
      liveRelayCount,
      relayStatuses,
      detail: `${liveRelayCount}/${relayCount} relays live`,
    };
  }

  if (liveRelayCount > 0) {
    if (reconnectingCount > 0 || closedCount > 0) {
      return {
        phase: "degraded",
        relayCount,
        readyRelayCount,
        liveRelayCount,
        relayStatuses,
        detail: `${liveRelayCount}/${relayCount} relays live, others reconnecting`,
      };
    }

    return {
      phase: "partial",
      relayCount,
      readyRelayCount,
      liveRelayCount,
      relayStatuses,
      detail: `${liveRelayCount}/${relayCount} relays live, others syncing`,
    };
  }

  if (subscribingCount > 0) {
    return {
      phase: "subscribing",
      relayCount,
      readyRelayCount,
      liveRelayCount,
      relayStatuses,
      detail: `${subscribingCount}/${relayCount} relays syncing`,
    };
  }

  if (connectingCount > 0) {
    return {
      phase: "connecting",
      relayCount,
      readyRelayCount,
      liveRelayCount,
      relayStatuses,
      detail: `${connectingCount}/${relayCount} relays connecting`,
    };
  }

  if (reconnectingCount > 0) {
    return {
      phase: "offline",
      relayCount,
      readyRelayCount,
      liveRelayCount,
      relayStatuses,
      detail: `${reconnectingCount}/${relayCount} relays reconnecting`,
    };
  }

  if (closedCount === relayCount) {
    return {
      phase: "closed",
      relayCount,
      readyRelayCount,
      liveRelayCount,
      relayStatuses,
      detail: "subscription closed",
    };
  }

  return {
    phase: "idle",
    relayCount,
    readyRelayCount,
    liveRelayCount,
    relayStatuses,
    detail: "idle",
  };
}

function countRelayPhases(
  relayStatuses: RelayStatus[],
  phase: RelayStatus["phase"],
) {
  return relayStatuses.filter((status) => status.phase === phase).length;
}

function buildRelayPublishErrorMessage(
  errors: RelayPublishResult["errors"],
) {
  if (errors.length === 0) {
    return "relay への publish に失敗しました";
  }

  const first = errors[0];

  if (errors.length === 1) {
    return `${first.relayUrl}: ${formatRelayAccessMessage(first.message) ?? first.message}`;
  }

  return `${errors.length} relay への publish が失敗しました: ${first.relayUrl}: ${formatRelayAccessMessage(first.message) ?? first.message}`;
}

function uniqueRelayUrls(relayUrls: string[]) {
  return [...new Set(relayUrls.map((relayUrl) => relayUrl.trim()).filter(Boolean))];
}

function selectConfiguredRelayUrls(
  configuredRelayUrls: string[],
  targetRelayUrls: string[],
) {
  const configured = new Set(configuredRelayUrls);

  return uniqueRelayUrls(targetRelayUrls).filter((relayUrl) => configured.has(relayUrl));
}

function buildRelayStatus(
  phase: RelayStatus["phase"],
  relayUrl: string,
  detail?: string,
  attempt = 0,
): RelayStatus {
  return {
    phase,
    relayUrl,
    attempt,
    detail,
  };
}
