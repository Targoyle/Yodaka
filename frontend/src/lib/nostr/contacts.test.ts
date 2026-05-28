import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildRelayAuthorMap,
  extractFollowTargets,
  fetchRecentNotesByAuthors,
  normalizeRelayUrls,
} from "./contacts";

type Listener = (event: unknown) => void;
type RelayFrame = [string, ...unknown[]];

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

  emitError() {
    this.emit("error", {});
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

describe("extractFollowTargets", () => {
  it("p タグから relay hint 付きの follow target を取り出す", () => {
    expect(
      extractFollowTargets([
        ["e", "event-id"],
        [
          "p",
          "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
          "wss://relay.one",
        ],
        ["p", "pubkey-b", "wss://relay.two/path", "bob"],
        [
          "p",
          "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          "wss://relay.three",
        ],
        [
          "p",
          "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          "invalid-relay",
        ],
        ["p", ""],
      ]),
    ).toEqual([
      {
        pubkey: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        relayHints: ["wss://relay.one/", "wss://relay.three/"],
      },
      {
        pubkey: "pubkey-b",
        relayHints: ["wss://relay.two/path"],
      },
    ]);
  });
});

describe("normalizeRelayUrls", () => {
  it("wss と localhost 向け ws だけを正規化し重複を除く", () => {
    expect(
      normalizeRelayUrls([
        "wss://yabu.me",
        "wss://yabu.me/",
        "https://example.com",
        "",
        "ws://localhost:7000",
        "ws://relay.local/path",
      ]),
    ).toEqual(["wss://yabu.me/", "ws://localhost:7000/"]);
  });
});

describe("buildRelayAuthorMap", () => {
  it("base relay と relay hint を合わせて author map を作る", () => {
    const relayAuthors = buildRelayAuthorMap(["wss://yabu.me"], [
      {
        pubkey: "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
        relayHints: ["wss://relay.one/"],
      },
      {
        pubkey: "pubkey-b",
        relayHints: ["wss://relay.one/", "wss://relay.two/"],
      },
    ]);

    expect(
      [...relayAuthors.entries()].map(([relayUrl, authors]) => [relayUrl, [...authors]]),
    ).toEqual([
      [
        "wss://yabu.me/",
        [
          "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          "pubkey-b",
        ],
      ],
      [
        "wss://relay.one/",
        [
          "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          "pubkey-b",
        ],
      ],
      ["wss://relay.two/", ["pubkey-b"]],
    ]);
  });
});

describe("fetchRecentNotesByAuthors", () => {
  it("全 relay が失敗した場合は空配列ではなくエラーにする", async () => {
    const promise = fetchRecentNotesByAuthors(
      ["wss://yabu.me", "wss://nos.lol"],
      ["author-a"],
      20,
    );

    const [firstSocket, secondSocket] = MockWebSocket.instances;
    firstSocket.emitOpen();
    secondSocket.emitOpen();
    firstSocket.emitError();
    secondSocket.emitError();

    await expect(promise).rejects.toThrow(
      "relay から投稿を取得できませんでした: 投稿取得に失敗しました",
    );
  });

  it("一部 relay だけ失敗した場合は成功分だけで空配列を返せる", async () => {
    const promise = fetchRecentNotesByAuthors(
      ["wss://yabu.me", "wss://nos.lol"],
      ["author-a"],
      20,
    );

    const [firstSocket, secondSocket] = MockWebSocket.instances;
    firstSocket.emitOpen();
    secondSocket.emitOpen();

    firstSocket.emitError();

    const secondFrames = sentFrames(secondSocket);
    const subscriptionId = secondFrames[0]?.[1] as string;
    secondSocket.emitMessage(JSON.stringify(["EOSE", subscriptionId]));

    await expect(promise).resolves.toEqual([]);
  });

  it("transport があれば既存 relay 接続を優先して使う", async () => {
    const transport = {
      calls: [] as Array<{
        relayUrl: string;
        filters: {
          kinds: number[];
          authors: string[];
          limit?: number;
        }[];
        timeoutMs?: number;
      }>,
      async requestTemporaryEvents(
        relayUrl: string,
        filters: {
          kinds: number[];
          authors: string[];
          limit?: number;
        }[],
        timeoutMs?: number,
      ) {
        this.calls.push({
          relayUrl,
          filters,
          timeoutMs,
        });

        return [
          {
            id: "transport-event-id",
            pubkey: "author-a",
            created_at: 1703184271,
            kind: 1,
            tags: [],
            content: "from transport",
            sig: "sig",
          },
        ];
      },
    };

    await expect(
      fetchRecentNotesByAuthors(
        ["wss://yabu.me"],
        ["author-a"],
        20,
        transport,
      ),
    ).resolves.toEqual([
      {
        id: "transport-event-id",
        pubkey: "author-a",
        created_at: 1703184271,
        kind: 1,
        tags: [],
        content: "from transport",
        sig: "sig",
      },
    ]);

    expect(transport.calls).toEqual([
      {
        relayUrl: "wss://yabu.me/",
        filters: [
          {
            kinds: [1],
            authors: ["author-a"],
            limit: 20,
          },
        ],
        timeoutMs: 8_000,
      },
    ]);
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("transport が未接続エラーなら direct WS へフォールバックする", async () => {
    const requestTemporaryEvents = vi
      .fn()
      .mockRejectedValue(new Error("relay is not connected"));

    const promise = fetchRecentNotesByAuthors(
      ["wss://yabu.me"],
      ["abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"],
      20,
      {
        requestTemporaryEvents,
      },
    );

    await waitForSocket();

    const [socket] = MockWebSocket.instances;
    socket.emitOpen();
    const subscriptionId = sentFrames(socket)[0]?.[1] as string;
    socket.emitMessage(JSON.stringify(["EOSE", subscriptionId]));

    await expect(promise).resolves.toEqual([]);
    expect(requestTemporaryEvents).toHaveBeenCalledTimes(1);
  });
});

function sentFrames(socket: MockWebSocket): RelayFrame[] {
  return socket.sent.map((message) => JSON.parse(message) as RelayFrame);
}

async function waitForSocket() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (MockWebSocket.instances.length > 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("MockWebSocket が作成されませんでした");
}
