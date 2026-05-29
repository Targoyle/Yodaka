import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredRelayRecord } from "./cache";
import type { NostrEvent } from "./relay";

type CacheModule = typeof import("./cache");

const DB_NAME = "nostr-client-v1";
const DB_VERSION = 1;
const RELAY_URL = "wss://yabu.me";
const SECOND_RELAY_URL = "wss://nos.lol";
const STORE_EVENTS = "events";
const STORE_PROFILES = "profiles";
const STORE_RELAYS = "relays";
const STORE_SETTINGS = "settings";
const INDEX_EVENTS_BY_RELAY_KIND_CREATED_AT = "byRelayKindCreatedAt";
const SETTING_SCHEMA_VERSION = "schema_version";

let cache: CacheModule;
let nextSequence = 1;

beforeEach(async () => {
  nextSequence = 1;
  vi.resetModules();
  vi.stubGlobal("window", globalThis);
  cache = await import("./cache");

  await cache.replayCachedRelay({
    relayUrl: RELAY_URL,
    insertEventJson: async () => false,
  });
  await clearAllData();
});

afterEach(async () => {
  await clearAllData();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("cache", () => {
  it("profile は replay せず、feed event だけ replay する", async () => {
    const pubkey = hexString(10, 64);
    const olderProfile = createEvent({
      pubkey,
      kind: 0,
      created_at: 100,
      content: JSON.stringify({ name: "older-profile" }),
    });
    const newerProfile = createEvent({
      pubkey,
      kind: 0,
      created_at: 120,
      content: JSON.stringify({ name: "newer-profile" }),
    });
    const olderFeed = createEvent({
      pubkey,
      kind: 1,
      created_at: 130,
      content: "feed-older",
    });
    const newerFeed = createEvent({
      pubkey: hexString(11, 64),
      kind: 1,
      created_at: 140,
      content: "feed-newer",
    });

    await cache.persistAcceptedEvent({ relayUrl: RELAY_URL, event: olderProfile });
    await cache.persistAcceptedEvent({ relayUrl: RELAY_URL, event: newerProfile });
    await cache.persistAcceptedEvent({ relayUrl: RELAY_URL, event: olderFeed });
    await cache.persistAcceptedEvent({ relayUrl: RELAY_URL, event: newerFeed });

    const replayed: Array<{ id: string; kind: number; content: string }> = [];
    const result = await cache.replayCachedRelay({
      relayUrl: RELAY_URL,
      insertEventJson: async (eventJson) => {
        const event = JSON.parse(eventJson) as {
          id: string;
          kind: number;
          content: string;
        };
        replayed.push(event);
        return true;
      },
    });

    expect(result.replayedProfiles).toBe(0);
    expect(result.replayedFeedEvents).toBe(2);
    expect(replayed.map((event) => event.id)).toEqual([
      olderFeed.id,
      newerFeed.id,
    ]);
  });

  it("relay state を保存し、replay 時に返す", async () => {
    const relayRecord: StoredRelayRecord = {
      url: RELAY_URL,
      sinceHint: 1_717_777_777,
      lastConnected: 1_777_000_123,
      enabled: true,
      read: true,
      write: true,
      nip65Managed: false,
      position: 0,
    };

    await cache.saveRelayState(relayRecord);

    const result = await cache.replayCachedRelay({
      relayUrl: RELAY_URL,
      insertEventJson: async () => true,
    });

    expect(result.replayedProfiles).toBe(0);
    expect(result.replayedFeedEvents).toBe(0);
    expect(result.relay).toEqual(relayRecord);
  });

  it("relay 設定 snapshot 更新では sinceHint と lastConnected を保持する", async () => {
    await cache.saveRelayState({
      url: RELAY_URL,
      sinceHint: 1_111,
      lastConnected: 2_222,
      enabled: true,
      read: true,
      write: true,
      nip65Managed: false,
      position: 0,
    });

    await cache.saveRelaySettingsSnapshot([
      {
        url: SECOND_RELAY_URL,
        enabled: true,
        read: false,
        write: true,
        nip65Managed: false,
      },
      {
        url: RELAY_URL,
        enabled: false,
        read: true,
        write: false,
        nip65Managed: true,
      },
    ]);

    const result = await cache.replayCachedRelays({
      relayUrls: [RELAY_URL, SECOND_RELAY_URL],
      insertEventJson: async () => true,
    });

    expect(result.relayRecords[RELAY_URL]).toEqual({
      url: RELAY_URL,
      sinceHint: 1_111,
      lastConnected: 2_222,
      enabled: false,
      read: true,
      write: false,
      nip65Managed: true,
      position: 1,
    });
    expect(result.relayRecords[SECOND_RELAY_URL]).toEqual({
      url: SECOND_RELAY_URL,
      sinceHint: null,
      lastConnected: 0,
      enabled: true,
      read: false,
      write: true,
      nip65Managed: false,
      position: 0,
    });
  });

  it("複数 relay replay では feed event だけを読み、relay ごとの state を返す", async () => {
    const pubkey = hexString(20, 64);
    const profile = createEvent({
      pubkey,
      kind: 0,
      created_at: 100,
      content: JSON.stringify({ name: "profile" }),
    });
    const firstFeed = createEvent({
      pubkey,
      created_at: 101,
      content: "feed-first",
    });
    const secondFeed = createEvent({
      pubkey: hexString(21, 64),
      created_at: 102,
      content: "feed-second",
    });

    await cache.persistAcceptedEvent({ relayUrl: RELAY_URL, event: profile });
    await cache.persistAcceptedEvent({ relayUrl: RELAY_URL, event: firstFeed });
    await cache.persistAcceptedEvent({ relayUrl: SECOND_RELAY_URL, event: secondFeed });
    await cache.saveRelayState({
      url: RELAY_URL,
      sinceHint: 1_111,
      lastConnected: 2_222,
      enabled: true,
      read: true,
      write: true,
      nip65Managed: false,
      position: 0,
    });
    await cache.saveRelayState({
      url: SECOND_RELAY_URL,
      sinceHint: 3_333,
      lastConnected: 4_444,
      enabled: true,
      read: false,
      write: true,
      nip65Managed: true,
      position: 1,
    });

    const replayedKinds: number[] = [];
    const result = await cache.replayCachedRelays({
      relayUrls: [RELAY_URL, SECOND_RELAY_URL],
      insertEventJson: async (eventJson) => {
        const event = JSON.parse(eventJson) as { kind: number };
        replayedKinds.push(event.kind);
        return true;
      },
    });

    expect(result.replayedProfiles).toBe(0);
    expect(result.replayedFeedEvents).toBe(2);
    expect(replayedKinds.filter((kind) => kind === 0)).toHaveLength(0);
    expect(result.relayRecords[RELAY_URL]).toMatchObject({
      sinceHint: 1_111,
      lastConnected: 2_222,
      read: true,
      write: true,
      nip65Managed: false,
      position: 0,
    });
    expect(result.relayRecords[SECOND_RELAY_URL]).toMatchObject({
      sinceHint: 3_333,
      lastConnected: 4_444,
      read: false,
      write: true,
      nip65Managed: true,
      position: 1,
    });
  });

  it("kind 7 reaction も feed event として保存・replay する", async () => {
    const note = createEvent({
      kind: 1,
      created_at: 150,
      content: "feed-note",
    });
    const reaction = createEvent({
      kind: 7,
      created_at: 151,
      content: "",
      tags: [
        ["e", note.id],
        ["p", note.pubkey],
        ["k", "1"],
      ],
    });

    await cache.persistAcceptedEvent({ relayUrl: RELAY_URL, event: note });
    await cache.persistAcceptedEvent({ relayUrl: RELAY_URL, event: reaction });

    const replayed: Array<{ kind: number; content: string }> = [];
    const result = await cache.replayCachedRelay({
      relayUrl: RELAY_URL,
      insertEventJson: async (eventJson) => {
        replayed.push(JSON.parse(eventJson) as { kind: number; content: string });
        return true;
      },
    });

    expect(result.replayedFeedEvents).toBe(2);
    expect(replayed.map((event) => event.kind)).toEqual([1, 7]);
    expect(replayed[1]?.content).toBe("");
  });

  it("relay state 一覧は event replay なしで取得できる", async () => {
    await cache.saveRelayState({
      url: RELAY_URL,
      sinceHint: 1_234,
      lastConnected: 5_678,
      enabled: true,
      read: true,
      write: false,
      nip65Managed: true,
      position: 2,
    });

    const result = await cache.loadRelayStates([RELAY_URL, SECOND_RELAY_URL]);

    expect(result[RELAY_URL]).toEqual({
      url: RELAY_URL,
      sinceHint: 1_234,
      lastConnected: 5_678,
      enabled: true,
      read: true,
      write: false,
      nip65Managed: true,
      position: 2,
    });
    expect(result[SECOND_RELAY_URL]).toBeNull();
  });

  it("旧 relay record は read/write 有効・nip65Managed 無効として読み込む", async () => {
    await putRawRelayRecord({
      url: RELAY_URL,
      sinceHint: 7_777,
      lastConnected: 8_888,
      enabled: false,
      position: 3,
    });

    const result = await cache.loadRelayStates([RELAY_URL]);

    expect(result[RELAY_URL]).toEqual({
      url: RELAY_URL,
      sinceHint: 7_777,
      lastConnected: 8_888,
      enabled: false,
      read: true,
      write: true,
      nip65Managed: false,
      position: 3,
    });
  });

  it("feed event を上限件数で prune し、最新 200 件だけ replay する", async () => {
    await seedFeedEvents(RELAY_URL, 1, 5_000);
    await cache.persistAcceptedEvent({
      relayUrl: RELAY_URL,
      event: createEvent({
        kind: 1,
        created_at: 5_001,
        content: "feed-5001",
      }),
    });

    expect(await countFeedEvents(RELAY_URL)).toBe(5_000);
    expect(await readFirstFeedCreatedAt(RELAY_URL)).toBe(2);

    const replayedFeedCreatedAt: number[] = [];
    const result = await cache.replayCachedRelay({
      relayUrl: RELAY_URL,
      insertEventJson: async (eventJson) => {
        const event = JSON.parse(eventJson) as { kind: number; created_at: number };

        if (event.kind === 1) {
          replayedFeedCreatedAt.push(event.created_at);
        }

        return true;
      },
    });

    expect(result.replayedFeedEvents).toBe(200);
    expect(replayedFeedCreatedAt).toHaveLength(200);
    expect(replayedFeedCreatedAt[0]).toBe(4_802);
    expect(replayedFeedCreatedAt.at(-1)).toBe(5_001);
  });

  it("指定 pubkey の cached profile だけを読み込める", async () => {
    const firstPubkey = hexString(30, 64);
    const secondPubkey = hexString(31, 64);
    const firstProfile = createEvent({
      pubkey: firstPubkey,
      kind: 0,
      created_at: 200,
      content: JSON.stringify({ display_name: "first" }),
    });
    const secondProfile = createEvent({
      pubkey: secondPubkey,
      kind: 0,
      created_at: 210,
      content: JSON.stringify({ display_name: "second" }),
    });

    await cache.persistAcceptedEvent({ relayUrl: RELAY_URL, event: firstProfile });
    await cache.persistAcceptedEvent({ relayUrl: RELAY_URL, event: secondProfile });

    const records = await cache.loadCachedProfilesByPubkeys([
      secondPubkey,
      hexString(32, 64),
      firstPubkey,
    ]);

    expect(records).toEqual([
      expect.objectContaining({
        pubkey: secondPubkey,
        createdAt: 210,
        eventId: secondProfile.id,
      }),
      expect.objectContaining({
        pubkey: firstPubkey,
        createdAt: 200,
        eventId: firstProfile.id,
      }),
    ]);
  });

  it("summary-only profile cache を保存して読み込める", async () => {
    const pubkey = hexString(40, 64);

    await cache.persistProfileSummary({
      pubkey,
      eventId: hexString(41, 64),
      createdAt: 300,
      profile: {
        name: "rain_256",
        displayName: "あめ",
        picture: null,
      },
    });

    const records = await cache.loadCachedProfilesByPubkeys([pubkey]);

    expect(records).toEqual([
      expect.objectContaining({
        pubkey,
        eventId: hexString(41, 64),
        createdAt: 300,
        summary: {
          name: "rain_256",
          displayName: "あめ",
          picture: null,
        },
      }),
    ]);
  });

  it("clearCacheDatabase で IndexedDB を全消去できる", async () => {
    const profile = createEvent({
      kind: 0,
      created_at: 100,
      content: JSON.stringify({ name: "cached-profile" }),
    });
    const feed = createEvent({
      kind: 1,
      created_at: 101,
      content: "cached-feed",
    });

    await cache.persistAcceptedEvent({ relayUrl: RELAY_URL, event: profile });
    await cache.persistAcceptedEvent({ relayUrl: RELAY_URL, event: feed });
    await cache.saveRelayState({
      url: RELAY_URL,
      sinceHint: 1_234,
      lastConnected: 5_678,
      enabled: true,
      read: true,
      write: true,
      nip65Managed: false,
      position: 0,
    });

    await cache.clearCacheDatabase();

    const replayed: string[] = [];
    const result = await cache.replayCachedRelay({
      relayUrl: RELAY_URL,
      insertEventJson: async (eventJson) => {
        replayed.push(eventJson);
        return true;
      },
    });

    expect(replayed).toEqual([]);
    expect(result.replayedProfiles).toBe(0);
    expect(result.replayedFeedEvents).toBe(0);
    expect(result.relay).toBeNull();
  });
});

function createEvent(overrides: Partial<NostrEvent>): NostrEvent {
  const sequence = nextSequence;
  nextSequence += 1;

  return {
    id: hexString(sequence, 64),
    pubkey: hexString(sequence + 10_000, 64),
    created_at: sequence,
    kind: 1,
    tags: [],
    content: `content-${sequence}`,
    sig: hexString(sequence + 20_000, 128),
    ...overrides,
  };
}

function hexString(value: number, length: number) {
  return value.toString(16).padStart(length, "0").slice(-length);
}

async function clearAllData() {
  const db = await openDatabase();

  await withTransaction(
    db,
    [STORE_EVENTS, STORE_PROFILES, STORE_RELAYS, STORE_SETTINGS],
    "readwrite",
    async (transaction) => {
      await requestToPromise(transaction.objectStore(STORE_EVENTS).clear());
      await requestToPromise(transaction.objectStore(STORE_PROFILES).clear());
      await requestToPromise(transaction.objectStore(STORE_RELAYS).clear());
      const settingsStore = transaction.objectStore(STORE_SETTINGS);
      await requestToPromise(settingsStore.clear());
      await requestToPromise(
        settingsStore.put({
          key: SETTING_SCHEMA_VERSION,
          value: 1,
          updatedAt: Date.now(),
        }),
      );
    },
  );

  db.close();
}

async function seedFeedEvents(relayUrl: string, startCreatedAt: number, count: number) {
  const db = await openDatabase();

  await withTransaction(db, [STORE_EVENTS], "readwrite", async (transaction) => {
    const eventStore = transaction.objectStore(STORE_EVENTS);

    for (let offset = 0; offset < count; offset += 1) {
      const createdAt = startCreatedAt + offset;
      const event = createEvent({
        kind: 1,
        created_at: createdAt,
        content: `feed-${createdAt}`,
      });

      await requestToPromise(
        eventStore.put({
          relayUrl,
          id: event.id,
          pubkey: event.pubkey,
          createdAt: event.created_at,
          kind: event.kind,
          rawJson: JSON.stringify({
            id: event.id,
            pubkey: event.pubkey,
            created_at: event.created_at,
            kind: event.kind,
            tags: event.tags,
            content: event.content,
            sig: event.sig,
          }),
          storedAt: createdAt,
        }),
      );
    }
  });

  db.close();
}

async function putRawRelayRecord(record: Record<string, unknown>) {
  const db = await openDatabase();

  await withTransaction(db, [STORE_RELAYS], "readwrite", async (transaction) => {
    await requestToPromise(transaction.objectStore(STORE_RELAYS).put(record));
  });

  db.close();
}

async function countFeedEvents(relayUrl: string) {
  const db = await openDatabase();
  const count = await withTransaction(
    db,
    [STORE_EVENTS],
    "readonly",
    async (transaction) => {
      const eventIndex = transaction
        .objectStore(STORE_EVENTS)
        .index(INDEX_EVENTS_BY_RELAY_KIND_CREATED_AT);
      const range = IDBKeyRange.bound(
        [relayUrl, 1, 0],
        [relayUrl, 1, Number.MAX_SAFE_INTEGER],
      );

      return requestToPromise<number>(eventIndex.count(range));
    },
  );

  db.close();
  return count;
}

async function readFirstFeedCreatedAt(relayUrl: string) {
  const db = await openDatabase();
  const createdAt = await withTransaction(
    db,
    [STORE_EVENTS],
    "readonly",
    async (transaction) => {
      const eventIndex = transaction
        .objectStore(STORE_EVENTS)
        .index(INDEX_EVENTS_BY_RELAY_KIND_CREATED_AT);
      const range = IDBKeyRange.bound(
        [relayUrl, 1, 0],
        [relayUrl, 1, Number.MAX_SAFE_INTEGER],
      );
      const cursor = await requestToPromise(eventIndex.openCursor(range, "next"));

      return ((cursor?.value as { createdAt?: number } | undefined)?.createdAt ?? null);
    },
  );

  db.close();
  return createdAt;
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(request.error ?? new Error("indexedDB open failed"));
    };

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(STORE_EVENTS)) {
        const store = database.createObjectStore(STORE_EVENTS, {
          keyPath: ["relayUrl", "id"],
        });
        store.createIndex(INDEX_EVENTS_BY_RELAY_KIND_CREATED_AT, [
          "relayUrl",
          "kind",
          "createdAt",
        ]);
      }

      if (!database.objectStoreNames.contains(STORE_PROFILES)) {
        const store = database.createObjectStore(STORE_PROFILES, {
          keyPath: "pubkey",
        });
        store.createIndex("byCreatedAt", "createdAt");
      }

      if (!database.objectStoreNames.contains(STORE_RELAYS)) {
        database.createObjectStore(STORE_RELAYS, {
          keyPath: "url",
        });
      }

      if (!database.objectStoreNames.contains(STORE_SETTINGS)) {
        database.createObjectStore(STORE_SETTINGS, {
          keyPath: "key",
        });
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };
  });
}

function withTransaction<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  callback: (transaction: IDBTransaction) => Promise<T>,
) {
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(stores, mode);
    let callbackResolved = false;
    let transactionCompleted = false;
    let callbackResult: T;
    let settled = false;

    const finishIfReady = () => {
      if (settled || !callbackResolved || !transactionCompleted) {
        return;
      }

      settled = true;
      resolve(callbackResult);
    };

    transaction.onerror = () => {
      if (settled) {
        return;
      }

      settled = true;
      reject(transaction.error ?? new Error("indexedDB transaction failed"));
    };

    transaction.onabort = () => {
      if (settled) {
        return;
      }

      settled = true;
      reject(transaction.error ?? new Error("indexedDB transaction aborted"));
    };

    transaction.oncomplete = () => {
      transactionCompleted = true;
      finishIfReady();
    };

    callback(transaction)
      .then((result) => {
        callbackResolved = true;
        callbackResult = result;
        finishIfReady();
      })
      .catch((error) => {
        if (settled) {
          return;
        }

        settled = true;
        reject(error);
        transaction.abort();
      });
  });
}

function requestToPromise<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error ?? new Error("indexedDB request failed"));
    };
  });
}
