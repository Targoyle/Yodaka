import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NostrEvent } from "./relay";
import {
  RelayCoordinator,
  RelayPublishError,
  type RelayCoordinatorStatus,
} from "./relayCoordinator";

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  MockWebSocket.instances = [];
});

describe("RelayCoordinator", () => {
  it("複数 relay の状態を partial -> live へ集約する", async () => {
    const statuses: RelayCoordinatorStatus[] = [];
    const coordinator = createRelayCoordinator({
      onStatus: (status) => {
        statuses.push(status);
      },
    });

    coordinator.connect();

    const firstSocket = MockWebSocket.instances[0];
    const secondSocket = MockWebSocket.instances[1];

    expect(firstSocket).toBeDefined();
    expect(secondSocket).toBeDefined();

    firstSocket.emitOpen();
    secondSocket.emitOpen();
    await flushAsync();

    const firstFeedRequest = sentFrames(firstSocket).find(
      (frame) =>
        frame[0] === "REQ" && isRecord(frame[2]) && Array.isArray(frame[2].kinds),
    );
    const secondFeedRequest = sentFrames(secondSocket).find(
      (frame) =>
        frame[0] === "REQ" && isRecord(frame[2]) && Array.isArray(frame[2].kinds),
    );

    expect(firstFeedRequest).toBeDefined();
    expect(secondFeedRequest).toBeDefined();

    firstSocket.emitMessage(JSON.stringify(["EOSE", firstFeedRequest?.[1]]));
    await flushAsync();

    expect(statuses.at(-1)).toMatchObject({
      phase: "partial",
      relayCount: 2,
      readyRelayCount: 1,
      liveRelayCount: 1,
    });

    secondSocket.emitMessage(JSON.stringify(["EOSE", secondFeedRequest?.[1]]));
    await flushAsync();

    expect(statuses.at(-1)).toMatchObject({
      phase: "live",
      relayCount: 2,
      readyRelayCount: 2,
      liveRelayCount: 2,
    });
  });

  it("profiles 要求は profileRelayUrls へだけ送る", async () => {
    const coordinator = createRelayCoordinator({
      profileRelayUrls: ["wss://nos.lol"],
    });

    coordinator.connect();

    const firstSocket = MockWebSocket.instances[0];
    const secondSocket = MockWebSocket.instances[1];
    firstSocket.emitOpen();
    secondSocket.emitOpen();
    await flushAsync();

    expect(coordinator.requestProfiles(["expected-author"])).toBe(1);

    const firstProfileRequest = sentFrames(firstSocket).find(
      (frame) =>
        frame[0] === "REQ"
        && isRecord(frame[2])
        && Array.isArray(frame[2].kinds)
        && frame[2].kinds[0] === 0,
    );
    const secondProfileRequest = sentFrames(secondSocket).find(
      (frame) =>
        frame[0] === "REQ"
        && isRecord(frame[2])
        && Array.isArray(frame[2].kinds)
        && frame[2].kinds[0] === 0,
    );

    expect(firstProfileRequest).toBeUndefined();
    expect(secondProfileRequest).toBeDefined();
  });

  it("temporary events 要求は指定 relay の既存接続へ送る", async () => {
    const coordinator = createRelayCoordinator();

    coordinator.connect();

    const firstSocket = MockWebSocket.instances[0];
    const secondSocket = MockWebSocket.instances[1];
    firstSocket.emitOpen();
    secondSocket.emitOpen();
    await flushAsync();

    const requestPromise = coordinator.requestTemporaryEvents(
      "wss://nos.lol",
      [{ kinds: [1], authors: ["expected-author"], limit: 10 }],
    );

    const firstTemporaryRequest = sentFrames(firstSocket).find(
      (frame) =>
        frame[0] === "REQ"
        && isRecord(frame[2])
        && Array.isArray(frame[2].kinds)
        && frameHasAuthor(frame[2], "expected-author"),
    );
    const secondTemporaryRequest = sentFrames(secondSocket).find(
      (frame) =>
        frame[0] === "REQ"
        && isRecord(frame[2])
        && Array.isArray(frame[2].kinds)
        && frameHasAuthor(frame[2], "expected-author"),
    );

    expect(firstTemporaryRequest).toBeUndefined();
    expect(secondTemporaryRequest).toBeDefined();

    const subscriptionId = secondTemporaryRequest?.[1] as string;
    secondSocket.emitMessage(
      JSON.stringify([
        "EVENT",
        subscriptionId,
        createEvent({
          id: "temporary-event-id",
          pubkey: "expected-author",
          content: "temporary note",
        }),
      ]),
    );
    secondSocket.emitMessage(JSON.stringify(["EOSE", subscriptionId]));

    await expect(requestPromise).resolves.toMatchObject([
      {
        id: "temporary-event-id",
        content: "temporary note",
      },
    ]);
  });

  it("temporary latest 要求は最新 event を返す", async () => {
    const coordinator = createRelayCoordinator();

    coordinator.connect();

    const firstSocket = MockWebSocket.instances[0];
    const secondSocket = MockWebSocket.instances[1];
    firstSocket.emitOpen();
    secondSocket.emitOpen();
    await flushAsync();

    const requestPromise = coordinator.requestTemporaryLatestEvent(
      "wss://yabu.me",
      [{ kinds: [3], authors: ["expected-author"] }],
    );

    const temporaryRequest = sentFrames(firstSocket).find(
      (frame) =>
        frame[0] === "REQ"
        && isRecord(frame[2])
        && Array.isArray(frame[2].kinds)
        && frame[2].kinds[0] === 3,
    );
    const subscriptionId = temporaryRequest?.[1] as string;

    firstSocket.emitMessage(
      JSON.stringify([
        "EVENT",
        subscriptionId,
        createEvent({
          id: "older-kind3",
          pubkey: "expected-author",
          kind: 3,
          content: "older",
        }),
      ]),
    );
    firstSocket.emitMessage(
      JSON.stringify([
        "EVENT",
        subscriptionId,
        createEvent({
          id: "newer-kind3",
          pubkey: "expected-author",
          created_at: 1703184272,
          kind: 3,
          content: "newer",
        }),
      ]),
    );
    firstSocket.emitMessage(JSON.stringify(["EOSE", subscriptionId]));

    await expect(requestPromise).resolves.toMatchObject({
      id: "newer-kind3",
      content: "newer",
    });
  });

  it("temporary latest 要求は kind3 の大量 p タグも返せる", async () => {
    const coordinator = createRelayCoordinator();

    coordinator.connect();

    const firstSocket = MockWebSocket.instances[0];
    const secondSocket = MockWebSocket.instances[1];
    firstSocket.emitOpen();
    secondSocket.emitOpen();
    await flushAsync();

    const requestPromise = coordinator.requestTemporaryLatestEvent(
      "wss://yabu.me",
      [{ kinds: [3], authors: ["expected-author"] }],
    );

    const temporaryRequest = sentFrames(firstSocket).find(
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

    firstSocket.emitMessage(
      JSON.stringify([
        "EVENT",
        subscriptionId,
        createEvent({
          id: "kind3-many-tags",
          pubkey: "expected-author",
          kind: 3,
          tags: followTags,
          content: "",
        }),
      ]),
    );
    firstSocket.emitMessage(JSON.stringify(["EOSE", subscriptionId]));

    await expect(requestPromise).resolves.toMatchObject({
      id: "kind3-many-tags",
      tags: followTags,
    });
  });

  it("publish を relay へ fan-out し、1 件以上 accepted なら成功扱いにする", async () => {
    const coordinator = createRelayCoordinator();

    coordinator.connect();

    const firstSocket = MockWebSocket.instances[0];
    const secondSocket = MockWebSocket.instances[1];
    firstSocket.emitOpen();
    secondSocket.emitOpen();
    await flushAsync();

    const event = createEvent({
      id: "published-event-id",
      pubkey: "expected-author",
      content: "hello publish",
    });
    const publishPromise = coordinator.publishEvent(event);

    const firstPublishFrame = sentFrames(firstSocket).find((frame) => frame[0] === "EVENT");
    const secondPublishFrame = sentFrames(secondSocket).find((frame) => frame[0] === "EVENT");

    expect(firstPublishFrame).toBeDefined();
    expect(secondPublishFrame).toBeDefined();

    firstSocket.emitMessage(JSON.stringify(["OK", event.id, true, "saved"]));
    secondSocket.emitMessage(JSON.stringify(["OK", event.id, false, "blocked"]));

    await expect(publishPromise).resolves.toEqual({
      acceptedRelayUrls: ["wss://yabu.me"],
      rejectedRelayUrls: ["wss://nos.lol"],
      errors: [
        {
          relayUrl: "wss://nos.lol",
          message: "blocked",
        },
      ],
    });
  });

  it("publish は publishRelayUrls へだけ送る", async () => {
    const coordinator = createRelayCoordinator({
      publishRelayUrls: ["wss://nos.lol"],
    });

    coordinator.connect();

    const firstSocket = MockWebSocket.instances[0];
    const secondSocket = MockWebSocket.instances[1];
    firstSocket.emitOpen();
    secondSocket.emitOpen();
    await flushAsync();

    const event = createEvent({
      id: "write-only-relay-event",
      pubkey: "expected-author",
      content: "write-only relay publish",
    });
    const publishPromise = coordinator.publishEvent(event);

    const firstPublishFrame = sentFrames(firstSocket).find((frame) => frame[0] === "EVENT");
    const secondPublishFrame = sentFrames(secondSocket).find((frame) => frame[0] === "EVENT");

    expect(firstPublishFrame).toBeUndefined();
    expect(secondPublishFrame).toBeDefined();

    secondSocket.emitMessage(JSON.stringify(["OK", event.id, true, "saved"]));

    await expect(publishPromise).resolves.toEqual({
      acceptedRelayUrls: ["wss://nos.lol"],
      rejectedRelayUrls: [],
      errors: [],
    });
  });

  it("publish が全 relay で失敗した場合は relay 別の情報を持つエラーを返す", async () => {
    const coordinator = createRelayCoordinator();

    coordinator.connect();

    const firstSocket = MockWebSocket.instances[0];
    const secondSocket = MockWebSocket.instances[1];
    firstSocket.emitOpen();
    secondSocket.emitOpen();
    await flushAsync();

    const event = createEvent({
      id: "rejected-event-id",
      pubkey: "expected-author",
      content: "all relays rejected",
    });
    const publishPromise = coordinator.publishEvent(event);

    firstSocket.emitMessage(JSON.stringify(["OK", event.id, false, "rate-limited"]));
    secondSocket.emitMessage(JSON.stringify(["OK", event.id, false, "blocked"]));

    await expect(publishPromise).rejects.toMatchObject({
      name: "RelayPublishError",
      rejectedRelayUrls: ["wss://yabu.me", "wss://nos.lol"],
      errors: [
        {
          relayUrl: "wss://yabu.me",
          message: "rate-limited",
        },
        {
          relayUrl: "wss://nos.lol",
          message: "blocked",
        },
      ],
    } satisfies Partial<RelayPublishError>);
  });

  it("publish の auth-required / restricted を user-facing message に整形する", async () => {
    const coordinator = createRelayCoordinator();

    coordinator.connect();

    const firstSocket = MockWebSocket.instances[0];
    const secondSocket = MockWebSocket.instances[1];
    firstSocket.emitOpen();
    secondSocket.emitOpen();
    await flushAsync();

    const event = createEvent({
      id: "auth-required-event-id",
      pubkey: "expected-author",
      content: "auth required",
    });
    const publishPromise = coordinator.publishEvent(event);

    firstSocket.emitMessage(JSON.stringify(["OK", event.id, false, "auth-required: login first"]));
    secondSocket.emitMessage(JSON.stringify(["OK", event.id, false, "restricted: paid users only"]));

    await expect(publishPromise).rejects.toMatchObject({
      name: "RelayPublishError",
      message:
        "2 relay への publish が失敗しました: wss://yabu.me: relay が認証を要求しています: login first",
      rejectedRelayUrls: ["wss://yabu.me", "wss://nos.lol"],
      errors: [
        {
          relayUrl: "wss://yabu.me",
          message: "auth-required: login first",
        },
        {
          relayUrl: "wss://nos.lol",
          message: "restricted: paid users only",
        },
      ],
    } satisfies Partial<RelayPublishError>);
  });
});

function createRelayCoordinator(
  overrides: Partial<ConstructorParameters<typeof RelayCoordinator>[0]> = {},
) {
  return new RelayCoordinator({
    relayUrls: ["wss://yabu.me", "wss://nos.lol"],
    buildFeedFilters: async () => [{ kinds: [1], limit: 50 }],
    onEvent: async () => {},
    ...overrides,
  });
}

function createEvent(overrides: Partial<NostrEvent>): NostrEvent {
  return {
    id: "38acf9b08d06859e49237688a9fd6558c448766f47457236c2331f93538992c6",
    pubkey: "e8ed3798c6ffebffa08501ac39e271662bfd160f688f94c45d692d8767dd345a",
    created_at: 1703184271,
    kind: 1,
    tags: [],
    content: "hello",
    sig: "f76d5ecc8e7de688ac12b9d19edaacdcffb8f0c8fa2a44c00767363af3f04dbc069542ddc5d2f63c94cb5e6ce701589d538cf2db3b1f1211a96596fabb6ecafe",
    ...overrides,
  };
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
