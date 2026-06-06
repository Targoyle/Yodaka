import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTemporaryRelayTransport } from "./temporaryRelayTransport";

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

describe("createTemporaryRelayTransport", () => {
  it("coordinator 不在時は events を空配列で返す", async () => {
    const transport = createTemporaryRelayTransport(() => null);

    await expect(
      transport.requestTemporaryEvents?.("wss://yabu.me", [{ kinds: [1] }], 8_000),
    ).resolves.toEqual([]);
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("coordinator 不在時は latest event を null で返す", async () => {
    const transport = createTemporaryRelayTransport(() => null);

    await expect(
      transport.requestTemporaryLatestEvent?.("wss://yabu.me", [{ kinds: [3] }], 8_000),
    ).resolves.toBeNull();
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("coordinator 管理外 relay は fallback client を共有する", async () => {
    const coordinator = {
      hasRelayClient: vi.fn(() => false),
      requestTemporaryEvents: vi.fn(),
      requestTemporaryLatestEvent: vi.fn(),
    };
    const transport = createTemporaryRelayTransport(
      () => coordinator as never,
    );

    const firstPromise = transport.requestTemporaryLatestEvent?.(
      "wss://hint.example",
      [{ kinds: [3], authors: ["author-a"] }],
      8_000,
    );
    const secondPromise = transport.requestTemporaryLatestEvent?.(
      "wss://hint.example",
      [{ kinds: [3], authors: ["author-b"] }],
      8_000,
    );

    expect(MockWebSocket.instances).toHaveLength(1);

    const socket = MockWebSocket.instances[0];
    socket.emitOpen();
    await flushAsync();

    const requests = sentFrames(socket).filter((frame) => frame[0] === "REQ");
    expect(requests).toHaveLength(2);

    const firstSubscriptionId = requests[0]?.[1] as string;
    const secondSubscriptionId = requests[1]?.[1] as string;

    socket.emitMessage(
      JSON.stringify([
        "EVENT",
        firstSubscriptionId,
        createEvent({
          id: "hint-event-a",
          pubkey: "author-a",
          kind: 3,
          content: "a",
        }),
      ]),
    );
    socket.emitMessage(JSON.stringify(["EOSE", firstSubscriptionId]));
    socket.emitMessage(
      JSON.stringify([
        "EVENT",
        secondSubscriptionId,
        createEvent({
          id: "hint-event-b",
          pubkey: "author-b",
          kind: 3,
          content: "b",
        }),
      ]),
    );
    socket.emitMessage(JSON.stringify(["EOSE", secondSubscriptionId]));

    await expect(firstPromise).resolves.toMatchObject({ id: "hint-event-a" });
    await expect(secondPromise).resolves.toMatchObject({ id: "hint-event-b" });
    expect(coordinator.requestTemporaryLatestEvent).not.toHaveBeenCalled();
  });

  it("coordinator 管理下 relay は既存 client を使う", async () => {
    const coordinator = {
      hasRelayClient: vi.fn(() => true),
      requestTemporaryEvents: vi.fn(async () => [{ id: "shared" }]),
      requestTemporaryLatestEvent: vi.fn(async () => ({ id: "shared-latest" })),
    };
    const transport = createTemporaryRelayTransport(
      () => coordinator as never,
    );

    await expect(
      transport.requestTemporaryEvents?.("wss://yabu.me", [{ kinds: [1] }], 8_000),
    ).resolves.toEqual([{ id: "shared" }]);
    await expect(
      transport.requestTemporaryLatestEvent?.("wss://yabu.me", [{ kinds: [3] }], 8_000),
    ).resolves.toEqual({ id: "shared-latest" });

    expect(coordinator.requestTemporaryEvents).toHaveBeenCalledTimes(1);
    expect(coordinator.requestTemporaryLatestEvent).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("managed relay へ昇格したら fallback client を閉じる", async () => {
    const coordinator = {
      hasRelayClient: vi.fn(() => false),
      requestTemporaryEvents: vi.fn(async () => [{ id: "managed" }]),
      requestTemporaryLatestEvent: vi.fn(),
    };
    const transport = createTemporaryRelayTransport(
      () => coordinator as never,
    );

    const fallbackPromise = transport.requestTemporaryEvents?.(
      "wss://hint.example",
      [{ kinds: [1], authors: ["author-a"] }],
      8_000,
    );
    const socket = MockWebSocket.instances[0];

    socket.emitOpen();
    await flushAsync();

    const subscriptionId = sentFrames(socket).find((frame) => frame[0] === "REQ")?.[1] as string;
    socket.emitMessage(
      JSON.stringify([
        "EVENT",
        subscriptionId,
        createEvent({
          id: "hint-note",
          pubkey: "author-a",
          kind: 1,
          content: "hello",
        }),
      ]),
    );
    socket.emitMessage(JSON.stringify(["EOSE", subscriptionId]));
    await expect(fallbackPromise).resolves.toMatchObject([{ id: "hint-note" }]);

    coordinator.hasRelayClient.mockReturnValue(true);

    await expect(
      transport.requestTemporaryEvents?.("wss://hint.example", [{ kinds: [1] }], 8_000),
    ).resolves.toEqual([{ id: "managed" }]);
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  });

  it("managed relay の未接続エラーは吸収する", async () => {
    const coordinator = {
      hasRelayClient: vi.fn(() => true),
      requestTemporaryEvents: vi.fn(async () => {
        throw new Error("relay is not connected");
      }),
      requestTemporaryLatestEvent: vi.fn(async () => {
        throw new Error("relay is not connected");
      }),
    };
    const transport = createTemporaryRelayTransport(
      () => coordinator as never,
    );

    await expect(
      transport.requestTemporaryEvents?.("wss://yabu.me", [{ kinds: [1] }], 8_000),
    ).resolves.toEqual([]);
    await expect(
      transport.requestTemporaryLatestEvent?.("wss://yabu.me", [{ kinds: [3] }], 8_000),
    ).resolves.toBeNull();
  });

  it("それ以外のエラーは再送出する", async () => {
    const coordinator = {
      hasRelayClient: vi.fn(() => true),
      requestTemporaryEvents: vi.fn(async () => {
        throw new Error("unexpected");
      }),
      requestTemporaryLatestEvent: vi.fn(async () => {
        throw new Error("unexpected");
      }),
    };
    const transport = createTemporaryRelayTransport(
      () => coordinator as never,
    );

    await expect(
      transport.requestTemporaryEvents?.("wss://yabu.me", [{ kinds: [1] }], 8_000),
    ).rejects.toThrow("unexpected");
    await expect(
      transport.requestTemporaryLatestEvent?.("wss://yabu.me", [{ kinds: [3] }], 8_000),
    ).rejects.toThrow("unexpected");
  });
});

function sentFrames(socket: MockWebSocket): RelayFrame[] {
  return socket.sent.map((message) => JSON.parse(message) as RelayFrame);
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
}

function createEvent(overrides: Partial<{
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}> = {}) {
  return {
    id: "event-id",
    pubkey: "author",
    created_at: 1703184271,
    kind: 1,
    tags: [],
    content: "hello",
    sig: "sig",
    ...overrides,
  };
}
