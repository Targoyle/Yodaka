import type { NostrEvent } from "./relay";

export type StoredEventRecord = {
  relayUrl: string;
  id: string;
  pubkey: string;
  createdAt: number;
  kind: number;
  rawJson: string;
  storedAt: number;
};

export type StoredProfileRecord = {
  pubkey: string;
  rawJson: string;
  rawContent: string;
  eventId: string;
  createdAt: number;
  fetchedAt: number;
};

export type StoredRelayRecord = {
  url: string;
  sinceHint: number | null;
  lastConnected: number;
  enabled: boolean;
  read: boolean;
  write: boolean;
  nip65Managed: boolean;
  position: number;
};

export type StoredSettingRecord = {
  key: string;
  value: unknown;
  updatedAt: number;
};

export type ReplayCacheResult = {
  replayedProfiles: number;
  replayedFeedEvents: number;
  relay: StoredRelayRecord | null;
};

export type ReplayMultiRelayCacheResult = {
  replayedProfiles: number;
  replayedFeedEvents: number;
  relayRecords: Record<string, StoredRelayRecord | null>;
};

const DB_NAME = "nostr-client-v1";
const DB_VERSION = 1;
const SCHEMA_VERSION = 1;
const STORE_EVENTS = "events";
const STORE_PROFILES = "profiles";
const STORE_RELAYS = "relays";
const STORE_SETTINGS = "settings";
const INDEX_EVENTS_BY_RELAY_KIND_CREATED_AT = "byRelayKindCreatedAt";
const INDEX_PROFILES_BY_CREATED_AT = "byCreatedAt";
const SETTING_SCHEMA_VERSION = "schema_version";
const CACHED_FEED_EVENT_KINDS = [1, 7] as const;
const MAX_CACHED_FEED_EVENTS_PER_RELAY_KIND = 5_000;
const MAX_CACHED_PROFILES = 2_000;
const MAX_REPLAY_FEED_EVENTS_PER_RELAY_KIND = 200;
const MAX_REPLAY_PROFILES = 256;

let openDatabasePromise: Promise<IDBDatabase | null> | null = null;

export async function clearCacheDatabase() {
  const db = await getCacheDatabase();

  if (!db) {
    return;
  }

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
          value: SCHEMA_VERSION,
          updatedAt: Date.now(),
        } satisfies StoredSettingRecord),
      );
    },
  );
}

export async function replayCachedRelay(args: {
  relayUrl: string;
  insertEventJson: (eventJson: string) => Promise<boolean>;
}): Promise<ReplayCacheResult> {
  const result = await replayCachedRelays({
    relayUrls: [args.relayUrl],
    insertEventJson: args.insertEventJson,
  });

  return {
    replayedProfiles: result.replayedProfiles,
    replayedFeedEvents: result.replayedFeedEvents,
    relay: result.relayRecords[args.relayUrl] ?? null,
  };
}

export async function replayCachedRelays(args: {
  relayUrls: string[];
  insertEventJson: (eventJson: string) => Promise<boolean>;
}): Promise<ReplayMultiRelayCacheResult> {
  const db = await getCacheDatabase();
  const relayUrls = uniqueRelayUrls(args.relayUrls);

  if (!db) {
    return {
      replayedProfiles: 0,
      replayedFeedEvents: 0,
      relayRecords: Object.fromEntries(relayUrls.map((relayUrl) => [relayUrl, null])),
    };
  }

  const [profileRecords, feedRecordsByRelay, relayRecordsList] = await Promise.all([
    listReplayProfiles(db),
    Promise.all(relayUrls.map((relayUrl) => listReplayFeedEvents(db, relayUrl))),
    Promise.all(relayUrls.map((relayUrl, index) => loadRelayRecord(db, relayUrl, index))),
  ]);
  const feedRecords = feedRecordsByRelay
    .flat()
    .sort((left, right) => {
      if (left.createdAt === right.createdAt) {
        if (left.relayUrl === right.relayUrl) {
          return left.id.localeCompare(right.id);
        }

        return left.relayUrl.localeCompare(right.relayUrl);
      }

      return left.createdAt - right.createdAt;
    });
  const relayRecords = Object.fromEntries(
    relayUrls.map((relayUrl, index) => [relayUrl, relayRecordsList[index] ?? null]),
  );

  let replayedProfiles = 0;

  for (const record of profileRecords) {
    try {
      if (await args.insertEventJson(record.rawJson)) {
        replayedProfiles += 1;
      }
    } catch (error) {
      reportCacheWarning("profile replay", error);
    }
  }

  let replayedFeedEvents = 0;

  for (const record of feedRecords) {
    try {
      if (await args.insertEventJson(record.rawJson)) {
        replayedFeedEvents += 1;
      }
    } catch (error) {
      reportCacheWarning("feed replay", error);
    }
  }

  return {
    replayedProfiles,
    replayedFeedEvents,
    relayRecords,
  };
}

export async function persistAcceptedEvent(args: {
  relayUrl: string;
  event: NostrEvent;
}) {
  const db = await getCacheDatabase();

  if (!db) {
    return;
  }

  if (isCachedFeedEventKind(args.event.kind)) {
    await upsertReplayEvent(db, args.relayUrl, args.event);
    return;
  }

  if (args.event.kind === 0) {
    await upsertProfileRecord(db, args.event);
  }
}

export async function saveRelayState(record: StoredRelayRecord) {
  const db = await getCacheDatabase();

  if (!db) {
    return;
  }

  await withTransaction(db, [STORE_RELAYS], "readwrite", async (transaction) => {
    const relayStore = transaction.objectStore(STORE_RELAYS);
    await requestToPromise(relayStore.put(normalizeStoredRelayRecord(record, record.position)));
  });
}

export async function saveRelaySettingsSnapshot(
  relaySettings: Array<{
    url: string;
    enabled: boolean;
    read: boolean;
    write: boolean;
    nip65Managed: boolean;
  }>,
) {
  const db = await getCacheDatabase();

  if (!db) {
    return;
  }

  const relayMap = new Map<
    string,
    {
      enabled: boolean;
      read: boolean;
      write: boolean;
      nip65Managed: boolean;
      position: number;
    }
  >();

  relaySettings.forEach((relaySetting, index) => {
    const relayUrl = relaySetting.url.trim();

    if (!relayUrl) {
      return;
    }

    relayMap.set(relayUrl, {
      enabled: relaySetting.enabled,
      read: relaySetting.read,
      write: relaySetting.write,
      nip65Managed: relaySetting.nip65Managed,
      position: index,
    });
  });

  await withTransaction(db, [STORE_RELAYS], "readwrite", async (transaction) => {
    const relayStore = transaction.objectStore(STORE_RELAYS);

    for (const [url, relaySetting] of relayMap) {
      const currentRecord = (await requestToPromise(
        relayStore.get(url),
      )) as StoredRelayRecord | undefined;
      const current = currentRecord
        ? normalizeStoredRelayRecord(currentRecord, relaySetting.position)
        : null;

      await requestToPromise(
        relayStore.put(
          normalizeStoredRelayRecord({
            url,
            sinceHint: current?.sinceHint ?? null,
            lastConnected: current?.lastConnected ?? 0,
            enabled: relaySetting.enabled,
            read: relaySetting.read,
            write: relaySetting.write,
            nip65Managed: relaySetting.nip65Managed,
            position: relaySetting.position,
          }, relaySetting.position),
        ),
      );
    }
  });
}

export async function loadRelayStates(relayUrls: string[]) {
  const db = await getCacheDatabase();
  const normalizedRelayUrls = uniqueRelayUrls(relayUrls);

  if (!db) {
    return Object.fromEntries(
      normalizedRelayUrls.map((relayUrl) => [relayUrl, null]),
    ) as Record<string, StoredRelayRecord | null>;
  }

  const records = await Promise.all(
    normalizedRelayUrls.map((relayUrl, index) => loadRelayRecord(db, relayUrl, index)),
  );

  return Object.fromEntries(
    normalizedRelayUrls.map((relayUrl, index) => [
      relayUrl,
      records[index] ?? null,
    ]),
  ) as Record<string, StoredRelayRecord | null>;
}

export async function loadCachedProfilesByPubkeys(pubkeys: string[]) {
  const db = await getCacheDatabase();
  const normalizedPubkeys = [
    ...new Set(pubkeys.map((pubkey) => pubkey.trim()).filter(Boolean)),
  ];

  if (!db || normalizedPubkeys.length === 0) {
    return [] as StoredProfileRecord[];
  }

  return withTransaction(db, [STORE_PROFILES], "readonly", async (transaction) => {
    const profileStore = transaction.objectStore(STORE_PROFILES);
    const records = await Promise.all(
      normalizedPubkeys.map(async (pubkey) => {
        const record = (await requestToPromise(
          profileStore.get(pubkey),
        )) as StoredProfileRecord | undefined;

        return record ?? null;
      }),
    );

    return records.filter((record): record is StoredProfileRecord => Boolean(record));
  });
}

async function getCacheDatabase() {
  if (typeof window === "undefined" || !("indexedDB" in window)) {
    return null;
  }

  if (!openDatabasePromise) {
    openDatabasePromise = openCacheDatabase()
      .then(async (db) => {
        await ensureSchemaVersion(db);
        return db;
      })
      .catch((error) => {
        openDatabasePromise = null;
        reportCacheWarning("indexeddb", error);

        return null;
      });
  }

  return openDatabasePromise;
}

function openCacheDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

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
        store.createIndex(INDEX_PROFILES_BY_CREATED_AT, "createdAt");
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

async function ensureSchemaVersion(db: IDBDatabase) {
  const current = await withTransaction(
    db,
    [STORE_SETTINGS],
    "readonly",
    async (transaction) => {
      const settingsStore = transaction.objectStore(STORE_SETTINGS);
      const record = await requestToPromise(
        settingsStore.get(SETTING_SCHEMA_VERSION),
      );

      return (record as StoredSettingRecord | undefined)?.value;
    },
  );

  if (current === SCHEMA_VERSION) {
    return;
  }

  await withTransaction(
    db,
    [STORE_EVENTS, STORE_PROFILES, STORE_RELAYS, STORE_SETTINGS],
    "readwrite",
    async (transaction) => {
      await requestToPromise(transaction.objectStore(STORE_EVENTS).clear());
      await requestToPromise(transaction.objectStore(STORE_PROFILES).clear());
      await requestToPromise(transaction.objectStore(STORE_RELAYS).clear());
      await requestToPromise(transaction.objectStore(STORE_SETTINGS).clear());
      await requestToPromise(
        transaction.objectStore(STORE_SETTINGS).put({
          key: SETTING_SCHEMA_VERSION,
          value: SCHEMA_VERSION,
          updatedAt: Date.now(),
        } satisfies StoredSettingRecord),
      );
    },
  );
}

async function upsertReplayEvent(
  db: IDBDatabase,
  relayUrl: string,
  event: NostrEvent,
) {
  const record: StoredEventRecord = {
    relayUrl,
    id: event.id,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    kind: event.kind,
    rawJson: stringifyEvent(event),
    storedAt: Date.now(),
  };

  await withTransaction(db, [STORE_EVENTS], "readwrite", async (transaction) => {
    const eventStore = transaction.objectStore(STORE_EVENTS);
    await requestToPromise(eventStore.put(record));
    await pruneReplayEvents(eventStore, relayUrl, event.kind);
  });
}

async function upsertProfileRecord(db: IDBDatabase, event: NostrEvent) {
  await withTransaction(
    db,
    [STORE_PROFILES],
    "readwrite",
    async (transaction) => {
      const profileStore = transaction.objectStore(STORE_PROFILES);
      const current = (await requestToPromise(
        profileStore.get(event.pubkey),
      )) as StoredProfileRecord | undefined;

      if (current && current.createdAt >= event.created_at) {
        return;
      }

      const record: StoredProfileRecord = {
        pubkey: event.pubkey,
        rawJson: stringifyEvent(event),
        rawContent: event.content,
        eventId: event.id,
        createdAt: event.created_at,
        fetchedAt: Date.now(),
      };

      await requestToPromise(profileStore.put(record));
      await pruneProfiles(profileStore);
    },
  );
}

async function pruneReplayEvents(
  eventStore: IDBObjectStore,
  relayUrl: string,
  kind: number,
) {
  const relayIndex = eventStore.index(INDEX_EVENTS_BY_RELAY_KIND_CREATED_AT);
  const range = IDBKeyRange.bound(
    [relayUrl, kind, 0],
    [relayUrl, kind, Number.MAX_SAFE_INTEGER],
  );
  const total = await requestToPromise(relayIndex.count(range));
  let excess = total - MAX_CACHED_FEED_EVENTS_PER_RELAY_KIND;

  if (excess <= 0) {
    return;
  }

  await iterateCursor<StoredEventRecord>(
    relayIndex.openCursor(range, "next"),
    async (cursor) => {
      if (excess <= 0) {
        return false;
      }

      await requestToPromise(cursor.delete());
      excess -= 1;
      return excess > 0;
    },
  );
}

async function pruneProfiles(profileStore: IDBObjectStore) {
  const profileIndex = profileStore.index(INDEX_PROFILES_BY_CREATED_AT);
  const total = await requestToPromise(profileIndex.count());
  let excess = total - MAX_CACHED_PROFILES;

  if (excess <= 0) {
    return;
  }

  await iterateCursor<StoredProfileRecord>(
    profileIndex.openCursor(null, "next"),
    async (cursor) => {
      if (excess <= 0) {
        return false;
      }

      await requestToPromise(cursor.delete());
      excess -= 1;
      return excess > 0;
    },
  );
}

async function listReplayProfiles(db: IDBDatabase) {
  return withTransaction(db, [STORE_PROFILES], "readonly", async (transaction) => {
    const profileIndex = transaction
      .objectStore(STORE_PROFILES)
      .index(INDEX_PROFILES_BY_CREATED_AT);
    const records: StoredProfileRecord[] = [];

    await iterateCursor<StoredProfileRecord>(
      profileIndex.openCursor(null, "prev"),
      async (cursor) => {
        records.push(cursor.value);
        return records.length < MAX_REPLAY_PROFILES;
      },
    );

    return records.reverse();
  });
}

async function listReplayFeedEvents(db: IDBDatabase, relayUrl: string) {
  return withTransaction(db, [STORE_EVENTS], "readonly", async (transaction) => {
    const eventIndex = transaction
      .objectStore(STORE_EVENTS)
      .index(INDEX_EVENTS_BY_RELAY_KIND_CREATED_AT);
    const records: StoredEventRecord[] = [];

    for (const kind of CACHED_FEED_EVENT_KINDS) {
      records.push(
        ...(await listReplayFeedEventsByKind(eventIndex, relayUrl, kind)),
      );
    }

    return records.sort((left, right) => {
      if (left.createdAt === right.createdAt) {
        if (left.kind === right.kind) {
          return left.id.localeCompare(right.id);
        }

        return left.kind - right.kind;
      }

      return left.createdAt - right.createdAt;
    });
  });
}

async function listReplayFeedEventsByKind(
  eventIndex: IDBIndex,
  relayUrl: string,
  kind: (typeof CACHED_FEED_EVENT_KINDS)[number],
) {
  const range = IDBKeyRange.bound(
    [relayUrl, kind, 0],
    [relayUrl, kind, Number.MAX_SAFE_INTEGER],
  );
  const records: StoredEventRecord[] = [];

  await iterateCursor<StoredEventRecord>(
    eventIndex.openCursor(range, "prev"),
    async (cursor) => {
      records.push(cursor.value);
      return records.length < MAX_REPLAY_FEED_EVENTS_PER_RELAY_KIND;
    },
  );

  return records.reverse();
}

async function loadRelayRecord(
  db: IDBDatabase,
  relayUrl: string,
  fallbackPosition: number,
) {
  return withTransaction(db, [STORE_RELAYS], "readonly", async (transaction) => {
    const relayStore = transaction.objectStore(STORE_RELAYS);

    const record = (await requestToPromise(
      relayStore.get(relayUrl),
    )) as StoredRelayRecord | undefined;

    return record ? normalizeStoredRelayRecord(record, fallbackPosition) : null;
  });
}

function normalizeStoredRelayRecord(
  record: Omit<StoredRelayRecord, "position"> & { position?: number },
  fallbackPosition: number,
): StoredRelayRecord {
  return {
    url: record.url,
    sinceHint:
      typeof record.sinceHint === "number" && Number.isFinite(record.sinceHint)
        ? Math.max(0, Math.floor(record.sinceHint))
        : null,
    lastConnected:
      typeof record.lastConnected === "number" && Number.isFinite(record.lastConnected)
        ? Math.max(0, record.lastConnected)
        : 0,
    enabled: record.enabled !== false,
    read: typeof record.read === "boolean" ? record.read : true,
    write: typeof record.write === "boolean" ? record.write : true,
    nip65Managed: record.nip65Managed === true,
    position:
      typeof record.position === "number" && Number.isInteger(record.position)
        ? Math.max(0, record.position)
        : fallbackPosition,
  };
}

function uniqueRelayUrls(relayUrls: string[]) {
  return [...new Set(relayUrls.map((relayUrl) => relayUrl.trim()).filter(Boolean))];
}

function isCachedFeedEventKind(kind: number): kind is (typeof CACHED_FEED_EVENT_KINDS)[number] {
  return kind === 1 || kind === 7;
}

function withTransaction<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  callback: (transaction: IDBTransaction) => Promise<T>,
) {
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(stores, mode);
    let settled = false;
    let callbackResolved = false;
    let transactionCompleted = false;
    let callbackResult: T;

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

async function iterateCursor<T>(
  request: IDBRequest<IDBCursorWithValue | null>,
  handler: (cursor: IDBCursorWithValue) => Promise<boolean> | boolean,
) {
  return new Promise<void>((resolve, reject) => {
    request.onerror = () => {
      reject(request.error ?? new Error("indexedDB cursor failed"));
    };

    request.onsuccess = async () => {
      const cursor = request.result;

      if (!cursor) {
        resolve();
        return;
      }

      try {
        const shouldContinue = await handler(cursor);

        if (!shouldContinue) {
          resolve();
          return;
        }

        cursor.continue();
      } catch (error) {
        reject(error);
      }
    };
  });
}

function stringifyEvent(event: NostrEvent) {
  return JSON.stringify({
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  });
}

function reportCacheWarning(scope: string, error: unknown) {
  if (!import.meta.env.DEV) {
    return;
  }

  console.warn(`[cache:${scope}]`, error);
}
