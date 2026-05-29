import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FEED_EOSE_TIMEOUT_MS,
  MAX_PROFILE_AUTHORS_PER_REQ,
  PROFILE_SUBSCRIPTION_TIMEOUT_MS,
  RELAY_OPEN_TIMEOUT_MS,
  RelayClient,
  TEMPORARY_SUBSCRIPTION_TIMEOUT_MS,
  matchesRelayFilter,
  type RelayClosedContext,
  type RelayEoseContext,
  type RelayEventContext,
  type RelayStatus,
  chunkProfileAuthors,
  inspectRelayMessage,
  parseRelayMessage,
} from "./relay";

type RelayFrame = [string, ...unknown[]];
type Listener = (event: unknown) => void;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }

  emitOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", {});
  }

  emitMessage(data: string) {
    this.emit("message", { data });
  }

  emitError() {
    this.emit("error", {});
  }

  emitClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", {});
  }

  private emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  MockWebSocket.instances = [];
});

describe("parseRelayMessage", () => {
  it("EVENT を解釈できる", () => {
    const message = parseRelayMessage(
      JSON.stringify([
        "EVENT",
        "feed-sub",
        {
          id: "38acf9b08d06859e49237688a9fd6558c448766f47457236c2331f93538992c6",
          pubkey: "e8ed3798c6ffebffa08501ac39e271662bfd160f688f94c45d692d8767dd345a",
          created_at: 1703184271,
          kind: 1,
          tags: [["t", "bitcoin"]],
          content: "hello",
          sig: "f76d5ecc8e7de688ac12b9d19edaacdcffb8f0c8fa2a44c00767363af3f04dbc069542ddc5d2f63c94cb5e6ce701589d538cf2db3b1f1211a96596fabb6ecafe",
        },
      ]),
    );

    expect(message).toEqual({
      type: "EVENT",
      subscriptionId: "feed-sub",
      event: {
        id: "38acf9b08d06859e49237688a9fd6558c448766f47457236c2331f93538992c6",
        pubkey: "e8ed3798c6ffebffa08501ac39e271662bfd160f688f94c45d692d8767dd345a",
        created_at: 1703184271,
        kind: 1,
        tags: [["t", "bitcoin"]],
        content: "hello",
        sig: "f76d5ecc8e7de688ac12b9d19edaacdcffb8f0c8fa2a44c00767363af3f04dbc069542ddc5d2f63c94cb5e6ce701589d538cf2db3b1f1211a96596fabb6ecafe",
      },
    });
  });

  it("EOSE / AUTH / NOTICE / CLOSED を解釈できる", () => {
    expect(parseRelayMessage('["EOSE","feed-sub"]')).toEqual({
      type: "EOSE",
      subscriptionId: "feed-sub",
    });
    expect(parseRelayMessage('["AUTH","challenge-token"]')).toEqual({
      type: "AUTH",
      challenge: "challenge-token",
    });
    expect(parseRelayMessage('["NOTICE","slow down"]')).toEqual({
      type: "NOTICE",
      message: "slow down",
    });
    expect(parseRelayMessage('["CLOSED","feed-sub","auth required"]')).toEqual({
      type: "CLOSED",
      subscriptionId: "feed-sub",
      message: "auth required",
    });
    expect(parseRelayMessage('["OK","event-id",true,"saved"]')).toEqual({
      type: "OK",
      eventId: "event-id",
      accepted: true,
      message: "saved",
    });
  });

  it("不正な envelope は null を返す", () => {
    expect(parseRelayMessage("not-json")).toBeNull();
    expect(parseRelayMessage('["EVENT","feed-sub",{"id":"x"}]')).toBeNull();
    expect(parseRelayMessage('["UNKNOWN","feed-sub"]')).toBeNull();
  });

  it("ローカル制限を超える EVENT は null を返す", () => {
    const oversizedContent = "x".repeat(8 * 1024 + 1);
    const tooManyTagFields = Array.from({ length: 17 }, (_, index) => `${index}`);

    expect(
      parseRelayMessage(
        JSON.stringify([
          "EVENT",
          "feed-sub",
          {
            id: "38acf9b08d06859e49237688a9fd6558c448766f47457236c2331f93538992c6",
            pubkey:
              "e8ed3798c6ffebffa08501ac39e271662bfd160f688f94c45d692d8767dd345a",
            created_at: 1703184271,
            kind: 1,
            tags: [["t", "nostr"]],
            content: oversizedContent,
            sig: "f76d5ecc8e7de688ac12b9d19edaacdcffb8f0c8fa2a44c00767363af3f04dbc069542ddc5d2f63c94cb5e6ce701589d538cf2db3b1f1211a96596fabb6ecafe",
          },
        ]),
      ),
    ).toBeNull();

    expect(
      parseRelayMessage(
        JSON.stringify([
          "EVENT",
          "feed-sub",
          {
            id: "38acf9b08d06859e49237688a9fd6558c448766f47457236c2331f93538992c6",
            pubkey:
              "e8ed3798c6ffebffa08501ac39e271662bfd160f688f94c45d692d8767dd345a",
            created_at: 1703184271,
            kind: 1,
            tags: [tooManyTagFields],
            content: "hello",
            sig: "f76d5ecc8e7de688ac12b9d19edaacdcffb8f0c8fa2a44c00767363af3f04dbc069542ddc5d2f63c94cb5e6ce701589d538cf2db3b1f1211a96596fabb6ecafe",
          },
        ]),
      ),
    ).toBeNull();
  });

  it("drop_message 用に破棄理由を分類できる", () => {
    const oversizedContent = "x".repeat(8 * 1024 + 1);
    const oversizedTagValue = "y".repeat(256 + 1);

    expect(inspectRelayMessage("not-json").diagnostic?.detail).toBe(
      "JSON として解釈できない relay message を破棄しました",
    );

    expect(
      inspectRelayMessage('["UNKNOWN","feed-sub"]').diagnostic?.detail,
    ).toBe("未対応 envelope を破棄しました: UNKNOWN");

    expect(
      inspectRelayMessage(
        JSON.stringify([
          "EVENT",
          "feed-sub",
          {
            id: "38acf9b08d06859e49237688a9fd6558c448766f47457236c2331f93538992c6",
            pubkey:
              "e8ed3798c6ffebffa08501ac39e271662bfd160f688f94c45d692d8767dd345a",
            created_at: 1703184271,
            kind: 1,
            tags: [],
            content: oversizedContent,
            sig: "f76d5ecc8e7de688ac12b9d19edaacdcffb8f0c8fa2a44c00767363af3f04dbc069542ddc5d2f63c94cb5e6ce701589d538cf2db3b1f1211a96596fabb6ecafe",
          },
        ]),
      ).diagnostic?.detail,
    ).toBe("EVENT content がローカル上限 8192 bytes を超えました");

    expect(
      inspectRelayMessage(
        JSON.stringify([
          "EVENT",
          "feed-sub",
          {
            id: "38acf9b08d06859e49237688a9fd6558c448766f47457236c2331f93538992c6",
            pubkey:
              "e8ed3798c6ffebffa08501ac39e271662bfd160f688f94c45d692d8767dd345a",
            created_at: 1703184271,
            kind: 1,
            tags: [["t", oversizedTagValue]],
            content: "hello",
            sig: "f76d5ecc8e7de688ac12b9d19edaacdcffb8f0c8fa2a44c00767363af3f04dbc069542ddc5d2f63c94cb5e6ce701589d538cf2db3b1f1211a96596fabb6ecafe",
          },
        ]),
      ).diagnostic?.detail,
    ).toBe("EVENT tag 値がローカル上限 256 bytes を超えました");
  });
});

describe("chunkProfileAuthors", () => {
  it("プロフィール要求を固定件数で分割する", () => {
    const authors = Array.from(
      { length: MAX_PROFILE_AUTHORS_PER_REQ + 5 },
      (_, index) => `author-${index}`,
    );
    const chunks = chunkProfileAuthors(["", authors[0], ...authors, authors[1]]);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(MAX_PROFILE_AUTHORS_PER_REQ);
    expect(chunks[1]).toEqual(
      authors.slice(MAX_PROFILE_AUTHORS_PER_REQ),
    );
  });
});

describe("matchesRelayFilter", () => {
  it("kinds / authors / since / until をローカル再検証できる", () => {
    const event = {
      id: "event-id",
      pubkey: "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
      created_at: 150,
      kind: 1,
      tags: [],
      content: "hello",
      sig: "sig",
    };

    expect(
      matchesRelayFilter(event, {
        kinds: [1],
        authors: [
          "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        ],
        since: 100,
        until: 200,
      }),
    ).toBe(true);
    expect(matchesRelayFilter(event, { kinds: [0] })).toBe(false);
    expect(matchesRelayFilter(event, { authors: ["other-author"] })).toBe(false);
    expect(matchesRelayFilter(event, { since: 151 })).toBe(false);
    expect(matchesRelayFilter(event, { until: 149 })).toBe(false);
  });
});

describe("RelayClient", () => {
  it("open timeout で再接続する", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);

    const statuses: RelayStatus[] = [];
    const client = createRelayClient({
      onStatus: (status: RelayStatus) => {
        statuses.push(status);
      },
    });

    client.connect();

    const firstSocket = MockWebSocket.instances[0];
    expect(firstSocket).toBeDefined();
    expect(statuses.map((status) => status.phase)).toEqual(["connecting"]);

    await vi.advanceTimersByTimeAsync(RELAY_OPEN_TIMEOUT_MS);

    expect(firstSocket.readyState).toBe(MockWebSocket.CLOSED);
    expect(statuses.at(-1)).toMatchObject({
      phase: "reconnecting",
      attempt: 1,
      retryInMs: 1000,
      detail: "reconnecting: relay open timed out",
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(statuses.at(-1)?.phase).toBe("connecting");
  });

  it("feed 購読で connecting -> subscribing -> live へ遷移する", async () => {
    const statuses: RelayStatus[] = [];
    const eoseContexts: RelayEoseContext[] = [];
    const client = createRelayClient({
      onStatus: (status: RelayStatus) => {
        statuses.push(status);
      },
      onEose: async (context: RelayEoseContext) => {
        eoseContexts.push(context);
      },
    });

    client.connect();

    const socket = MockWebSocket.instances[0];
    expect(socket).toBeDefined();
    expect(statuses.map((status) => status.phase)).toEqual(["connecting"]);

    socket.emitOpen();
    await flushAsync();

    const feedRequest = sentFrames(socket).find(
      (frame) =>
        frame[0] === "REQ" && isRecord(frame[2]) && Array.isArray(frame[2].kinds),
    );

    expect(feedRequest).toBeDefined();
    expect(feedRequest?.[2]).toEqual({ kinds: [1], limit: 50 });
    expect(statuses.at(-1)?.phase).toBe("subscribing");

    const subscriptionId = feedRequest?.[1] as string;
    socket.emitMessage(JSON.stringify(["EOSE", subscriptionId]));
    await flushAsync();

    expect(statuses.at(-1)?.phase).toBe("live");
    expect(eoseContexts).toEqual([
      {
        role: "feed",
        subscriptionId,
      },
    ]);
  });

  it("feed の initial EOSE timeout で local completion 扱いにする", async () => {
    vi.useFakeTimers();

    const statuses: RelayStatus[] = [];
    const eoseContexts: RelayEoseContext[] = [];
    const client = createRelayClient({
      onStatus: (status: RelayStatus) => {
        statuses.push(status);
      },
      onEose: async (context: RelayEoseContext) => {
        eoseContexts.push(context);
      },
    });

    client.connect();

    const socket = MockWebSocket.instances[0];
    socket.emitOpen();
    await flushAsync();

    const feedRequest = sentFrames(socket).find(
      (frame) =>
        frame[0] === "REQ" && isRecord(frame[2]) && Array.isArray(frame[2].kinds),
    );
    const subscriptionId = feedRequest?.[1] as string;

    await vi.advanceTimersByTimeAsync(FEED_EOSE_TIMEOUT_MS);
    await flushAsync();

    expect(statuses.at(-1)).toMatchObject({
      phase: "live",
      detail: "initial sync timed out, receiving live events",
    });
    expect(eoseContexts).toEqual([
      {
        role: "feed",
        subscriptionId,
      },
    ]);
    expect(sentFrames(socket).filter((frame) => frame[0] === "CLOSE")).toHaveLength(0);

    socket.emitMessage(JSON.stringify(["EOSE", subscriptionId]));
    await flushAsync();

    expect(eoseContexts).toHaveLength(1);
  });

  it("feed で EOSE を受けた後は timeout が再発しない", async () => {
    vi.useFakeTimers();

    const eoseContexts: RelayEoseContext[] = [];
    const client = createRelayClient({
      onEose: async (context: RelayEoseContext) => {
        eoseContexts.push(context);
      },
    });

    client.connect();

    const socket = MockWebSocket.instances[0];
    socket.emitOpen();
    await flushAsync();

    const feedRequest = sentFrames(socket).find(
      (frame) =>
        frame[0] === "REQ" && isRecord(frame[2]) && Array.isArray(frame[2].kinds),
    );
    const subscriptionId = feedRequest?.[1] as string;

    socket.emitMessage(JSON.stringify(["EOSE", subscriptionId]));
    await flushAsync();

    await vi.advanceTimersByTimeAsync(FEED_EOSE_TIMEOUT_MS);
    await flushAsync();

    expect(eoseContexts).toEqual([
      {
        role: "feed",
        subscriptionId,
      },
    ]);
  });

  it("feed filter が空なら購読せず live に入る", async () => {
    const statuses: RelayStatus[] = [];
    const client = createRelayClient({
      buildFeedFilters: async () => [],
      onStatus: (status: RelayStatus) => {
        statuses.push(status);
      },
    });

    client.connect();

    const socket = MockWebSocket.instances[0];
    socket.emitOpen();
    await flushAsync();

    const feedRequests = sentFrames(socket).filter((frame) => frame[0] === "REQ");

    expect(feedRequests).toHaveLength(0);
    expect(statuses.map((status) => status.phase)).toEqual(["connecting", "live"]);
    expect(statuses.at(-1)?.detail).toBe("connected without feed subscription");
  });

  it("profiles 購読を分割し、relay 依存の limit を付けずに各 EOSE 後に CLOSE を送る", async () => {
    const eoseContexts: RelayEoseContext[] = [];
    const client = createRelayClient({
      onEose: async (context: RelayEoseContext) => {
        eoseContexts.push(context);
      },
    });

    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.emitOpen();
    await flushAsync();

    const authors = Array.from(
      { length: MAX_PROFILE_AUTHORS_PER_REQ + 5 },
      (_, index) => `author-${index}`,
    );

    expect(client.requestProfiles(authors)).toBe(authors.length);

    const profileRequests = sentFrames(socket).filter(
      (frame) =>
        frame[0] === "REQ" &&
        isRecord(frame[2]) &&
        Array.isArray(frame[2].kinds) &&
        frame[2].kinds[0] === 0,
    );

    expect(profileRequests).toHaveLength(2);
    expect((profileRequests[0][2] as { authors: string[] }).authors).toHaveLength(
      MAX_PROFILE_AUTHORS_PER_REQ,
    );
    expect(profileRequests[0][2]).not.toHaveProperty("limit");
    expect((profileRequests[1][2] as { authors: string[] }).authors).toEqual(
      authors.slice(MAX_PROFILE_AUTHORS_PER_REQ),
    );
    expect(profileRequests[1][2]).not.toHaveProperty("limit");

    const profileSubIds = profileRequests.map((frame) => frame[1] as string);
    socket.emitMessage(JSON.stringify(["EOSE", profileSubIds[0]]));
    await flushAsync();
    socket.emitMessage(JSON.stringify(["EOSE", profileSubIds[1]]));
    await flushAsync();

    const closeFrames = sentFrames(socket).filter((frame) => frame[0] === "CLOSE");
    expect(closeFrames).toEqual([
      ["CLOSE", profileSubIds[0]],
      ["CLOSE", profileSubIds[1]],
    ]);
    expect(eoseContexts.filter((context) => context.role === "profiles")).toEqual([
      { role: "profiles", subscriptionId: profileSubIds[0] },
      { role: "profiles", subscriptionId: profileSubIds[1] },
    ]);
  });

  it("feed CLOSED 後に再接続して再購読する", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);

    const statuses: RelayStatus[] = [];
    const closedContexts: RelayClosedContext[] = [];
    const client = createRelayClient({
      onStatus: (status: RelayStatus) => {
        statuses.push(status);
      },
      onClosed: (context: RelayClosedContext) => {
        closedContexts.push(context);
      },
    });

    client.connect();
    const firstSocket = MockWebSocket.instances[0];
    firstSocket.emitOpen();
    await flushAsync();

    const firstFeedRequest = sentFrames(firstSocket).find(
      (frame) =>
        frame[0] === "REQ" && isRecord(frame[2]) && Array.isArray(frame[2].kinds),
    );
    const firstSubscriptionId = firstFeedRequest?.[1] as string;

    firstSocket.emitMessage(
      JSON.stringify(["CLOSED", firstSubscriptionId, "auth required"]),
    );
    await flushAsync();

    expect(statuses.at(-1)).toMatchObject({
      phase: "reconnecting",
      attempt: 1,
      retryInMs: 1000,
    });
    expect(closedContexts).toEqual([
      {
        role: "feed",
        subscriptionId: firstSubscriptionId,
        message: "auth required",
      },
    ]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(MockWebSocket.instances).toHaveLength(2);

    const secondSocket = MockWebSocket.instances[1];
    expect(statuses.at(-1)?.phase).toBe("connecting");

    secondSocket.emitOpen();
    await flushAsync();

    const secondFeedRequest = sentFrames(secondSocket).find(
      (frame) =>
        frame[0] === "REQ" && isRecord(frame[2]) && Array.isArray(frame[2].kinds),
    );

    expect(secondFeedRequest).toBeDefined();
    expect(statuses.at(-1)?.phase).toBe("subscribing");
  });

  it("profiles 購読では要求した pubkey の kind 0 だけを onEvent へ流す", async () => {
    const events: RelayEventContext[] = [];
    const client = createRelayClient({
      onEvent: async (context: RelayEventContext) => {
        events.push(context);
      },
    });

    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.emitOpen();
    await flushAsync();

    expect(client.requestProfiles(["expected-author"])).toBe(1);

    const profileRequest = sentFrames(socket).find(
      (frame) =>
        frame[0] === "REQ" &&
        isRecord(frame[2]) &&
        Array.isArray(frame[2].kinds) &&
        frame[2].kinds[0] === 0,
    );
    const profileSubId = profileRequest?.[1] as string;

    socket.emitMessage(
      JSON.stringify([
        "EVENT",
        profileSubId,
        {
          id: "profile-ignored",
          pubkey: "unexpected-author",
          created_at: 1703184271,
          kind: 0,
          tags: [],
          content: "{}",
          sig: "sig",
        },
      ]),
    );
    await flushAsync();

    socket.emitMessage(
      JSON.stringify([
        "EVENT",
        profileSubId,
        {
          id: "profile-accepted",
          pubkey: "expected-author",
          created_at: 1703184271,
          kind: 0,
          tags: [],
          content: "{}",
          sig: "sig",
        },
      ]),
    );
    await flushAsync();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      role: "profiles",
      subscriptionId: profileSubId,
      event: {
        pubkey: "expected-author",
        kind: 0,
      },
    });
  });

  it("profiles 購読は EOSE 未着でも timeout で CLOSE する", async () => {
    vi.useFakeTimers();

    const client = createRelayClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.emitOpen();
    await flushAsync();

    expect(client.requestProfiles(["author-timeout"])).toBe(1);

    const profileRequest = sentFrames(socket).find(
      (frame) =>
        frame[0] === "REQ" &&
        isRecord(frame[2]) &&
        Array.isArray(frame[2].kinds) &&
        frame[2].kinds[0] === 0,
    );
    const profileSubId = profileRequest?.[1] as string;

    await vi.advanceTimersByTimeAsync(PROFILE_SUBSCRIPTION_TIMEOUT_MS);

    const closeFrames = sentFrames(socket).filter((frame) => frame[0] === "CLOSE");
    expect(closeFrames).toContainEqual(["CLOSE", profileSubId]);
  });

  it("temporary events 要求を既存接続で処理する", async () => {
    const client = createRelayClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.emitOpen();
    await flushAsync();

    const requestPromise = client.requestTemporaryEvents([
      {
        kinds: [1],
        authors: ["expected-author"],
        limit: 10,
      },
    ]);

    const temporaryRequest = sentFrames(socket).find(
      (frame) =>
        frame[0] === "REQ"
        && isRecord(frame[2])
        && Array.isArray(frame[2].kinds)
        && frame[2].kinds[0] === 1
        && frameHasAuthor(frame[2], "expected-author"),
    );
    const subscriptionId = temporaryRequest?.[1] as string;

    socket.emitMessage(
      JSON.stringify([
        "EVENT",
        subscriptionId,
        {
          id: "temporary-event-id",
          pubkey: "expected-author",
          created_at: 1703184271,
          kind: 1,
          tags: [],
          content: "hello temporary",
          sig: "sig",
        },
      ]),
    );
    socket.emitMessage(JSON.stringify(["EOSE", subscriptionId]));

    await expect(requestPromise).resolves.toEqual([
      {
        id: "temporary-event-id",
        pubkey: "expected-author",
        created_at: 1703184271,
        kind: 1,
        tags: [],
        content: "hello temporary",
        sig: "sig",
      },
    ]);

    const closeFrames = sentFrames(socket).filter((frame) => frame[0] === "CLOSE");
    expect(closeFrames).toContainEqual(["CLOSE", subscriptionId]);
  });

  it("temporary latest 要求は新しい event を返す", async () => {
    const client = createRelayClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.emitOpen();
    await flushAsync();

    const requestPromise = client.requestTemporaryLatestEvent([
      {
        kinds: [3],
        authors: ["expected-author"],
      },
    ]);

    const temporaryRequest = sentFrames(socket).find(
      (frame) =>
        frame[0] === "REQ"
        && isRecord(frame[2])
        && Array.isArray(frame[2].kinds)
        && frame[2].kinds[0] === 3,
    );
    const subscriptionId = temporaryRequest?.[1] as string;

    socket.emitMessage(
      JSON.stringify([
        "EVENT",
        subscriptionId,
        {
          id: "older-profile",
          pubkey: "expected-author",
          created_at: 1703184271,
          kind: 3,
          tags: [],
          content: "older",
          sig: "sig",
        },
      ]),
    );
    socket.emitMessage(
      JSON.stringify([
        "EVENT",
        subscriptionId,
        {
          id: "newer-profile",
          pubkey: "expected-author",
          created_at: 1703184272,
          kind: 3,
          tags: [],
          content: "newer",
          sig: "sig",
        },
      ]),
    );
    socket.emitMessage(JSON.stringify(["EOSE", subscriptionId]));

    await expect(requestPromise).resolves.toMatchObject({
      id: "newer-profile",
      content: "newer",
    });
  });

  it("temporary latest 要求は kind3 の大量 p タグを受け取れる", async () => {
    const client = createRelayClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.emitOpen();
    await flushAsync();

    const requestPromise = client.requestTemporaryLatestEvent([
      {
        kinds: [3],
        authors: ["expected-author"],
      },
    ]);

    const temporaryRequest = sentFrames(socket).find(
      (frame) =>
        frame[0] === "REQ"
        && isRecord(frame[2])
        && Array.isArray(frame[2].kinds)
        && frame[2].kinds[0] === 3,
    );
    const subscriptionId = temporaryRequest?.[1] as string;
    const followTags = Array.from({ length: 65 }, (_, index) => [
      "p",
      `follow-pubkey-${index}`,
    ]);

    socket.emitMessage(
      JSON.stringify([
        "EVENT",
        subscriptionId,
        {
          id: "kind3-many-tags",
          pubkey: "expected-author",
          created_at: 1703184273,
          kind: 3,
          tags: followTags,
          content: "",
          sig: "sig",
        },
      ]),
    );
    socket.emitMessage(JSON.stringify(["EOSE", subscriptionId]));

    await expect(requestPromise).resolves.toMatchObject({
      id: "kind3-many-tags",
      tags: followTags,
    });
  });

  it("temporary 要求は未接続 relay では失敗する", async () => {
    const client = createRelayClient();

    await expect(
      client.requestTemporaryEvents([{ kinds: [1], authors: ["expected-author"] }]),
    ).rejects.toThrow("relay is not connected");
  });

  it("temporary 要求は timeout で失敗する", async () => {
    vi.useFakeTimers();

    const client = createRelayClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.emitOpen();
    await flushAsync();

    const requestPromise = client.requestTemporaryEvents([
      { kinds: [1], authors: ["expected-author"] },
    ]);
    const assertion = expect(requestPromise).rejects.toThrow(
      "temporary relay request timed out",
    );

    await vi.advanceTimersByTimeAsync(TEMPORARY_SUBSCRIPTION_TIMEOUT_MS);

    await assertion;
  });

  it("feed 購読では filter と一致しない EVENT を破棄する", async () => {
    const events: RelayEventContext[] = [];
    const client = createRelayClient({
      buildFeedFilters: async () => [
        {
          kinds: [1],
          authors: ["expected-author"],
          since: 100,
          until: 200,
          limit: 50,
        },
      ],
      onEvent: async (context: RelayEventContext) => {
        events.push(context);
      },
    });

    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.emitOpen();
    await flushAsync();

    const feedRequest = sentFrames(socket).find(
      (frame) =>
        frame[0] === "REQ" && isRecord(frame[2]) && Array.isArray(frame[2].kinds),
    );
    const subscriptionId = feedRequest?.[1] as string;

    socket.emitMessage(
      JSON.stringify([
        "EVENT",
        subscriptionId,
        {
          id: "too-old",
          pubkey: "expected-author",
          created_at: 99,
          kind: 1,
          tags: [],
          content: "old",
          sig: "sig",
        },
      ]),
    );
    socket.emitMessage(
      JSON.stringify([
        "EVENT",
        subscriptionId,
        {
          id: "wrong-author",
          pubkey: "other-author",
          created_at: 150,
          kind: 1,
          tags: [],
          content: "wrong",
          sig: "sig",
        },
      ]),
    );
    socket.emitMessage(
      JSON.stringify([
        "EVENT",
        subscriptionId,
        {
          id: "accepted",
          pubkey: "expected-author",
          created_at: 150,
          kind: 1,
          tags: [],
          content: "ok",
          sig: "sig",
        },
      ]),
    );
    await flushAsync();

    expect(events).toHaveLength(1);
    expect(events[0]?.event.id).toBe("accepted");
  });

  it("publishEvent は OK accepted で解決する", async () => {
    const client = createRelayClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.emitOpen();
    await flushAsync();

    const event = {
      id: "published-event-id",
      pubkey: "expected-author",
      created_at: 1703184271,
      kind: 1,
      tags: [],
      content: "hello publish",
      sig: "sig",
    };

    const publishPromise = client.publishEvent(event);
    const publishFrame = sentFrames(socket).find((frame) => frame[0] === "EVENT");

    expect(publishFrame).toEqual([
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

    socket.emitMessage(JSON.stringify(["OK", event.id, true, "saved"]));
    await expect(publishPromise).resolves.toBeUndefined();
  });

  it("publishEvent は OK rejected で失敗する", async () => {
    const client = createRelayClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.emitOpen();
    await flushAsync();

    const event = {
      id: "published-event-id",
      pubkey: "expected-author",
      created_at: 1703184271,
      kind: 1,
      tags: [],
      content: "hello publish",
      sig: "sig",
    };

    const publishPromise = client.publishEvent(event);
    socket.emitMessage(JSON.stringify(["OK", event.id, false, "blocked"]));

    await expect(publishPromise).rejects.toThrow("blocked");
  });
});

function createRelayClient(
  overrides: Partial<ConstructorParameters<typeof RelayClient>[0]> = {},
) {
  return new RelayClient({
    relayUrl: "wss://yabu.me",
    buildFeedFilters: async () => [{ kinds: [1], limit: 50 }],
    onEvent: async () => {},
    ...overrides,
  });
}

function sentFrames(socket: MockWebSocket): RelayFrame[] {
  return socket.sent.map((message) => JSON.parse(message) as RelayFrame);
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function frameHasAuthor(
  value: unknown,
  expectedAuthor: string,
): value is { authors: string[]; kinds?: number[] } {
  if (!isRecord(value) || !Array.isArray(value.authors)) {
    return false;
  }

  return value.authors[0] === expectedAuthor;
}
