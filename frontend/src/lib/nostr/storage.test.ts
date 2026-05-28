import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearAppStorage,
  listActiveRelayUrls,
  listReadRelayUrls,
  loadProfileImagesEnabled,
  loadDeveloperModeEnabled,
  loadRelaySettings,
  loadRelayUrls,
  loadThemePreference,
  listWriteRelayUrls,
  saveDeveloperModeEnabled,
  saveManualPubkey,
  saveProfileImagesEnabled,
  saveRelaySettings,
  saveThemePreference,
} from "./storage";

const DEVELOPER_MODE_ENABLED_KEY = "nostr-client.developer-mode-enabled";
const MANUAL_PUBKEY_KEY = "nostr-client.manual-pubkey";
const PROFILE_IMAGES_ENABLED_KEY = "nostr-client.profile-images-enabled";
const RELAY_SETTINGS_KEY = "nostr-client.relay-settings";
const RELAY_URLS_KEY = "nostr-client.relay-urls";
const THEME_PREFERENCE_KEY = "nostr-client.theme-preference";

describe("loadThemePreference", () => {
  beforeEach(() => {
    const storage = createLocalStorageStub();

    vi.stubGlobal("window", {
      localStorage: storage,
      matchMedia: vi.fn(() => ({ matches: false })),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("保存値がなければシステムテーマから初期値を決めて保存する", () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);

    expect(loadThemePreference()).toBe("dark");
    expect(window.localStorage.getItem(THEME_PREFERENCE_KEY)).toBe("dark");
  });

  it("既存の保存値があればそれを優先する", () => {
    saveThemePreference("light");
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);

    expect(loadThemePreference()).toBe("light");
    expect(window.localStorage.getItem(THEME_PREFERENCE_KEY)).toBe("light");
  });

  it("旧 system 保存値は現在のシステムテーマへ移行する", () => {
    window.localStorage.setItem(THEME_PREFERENCE_KEY, "system");
    vi.mocked(window.matchMedia).mockReturnValue({ matches: false } as MediaQueryList);

    expect(loadThemePreference()).toBe("light");
    expect(window.localStorage.getItem(THEME_PREFERENCE_KEY)).toBe("light");
  });
});

describe("developer mode", () => {
  beforeEach(() => {
    const storage = createLocalStorageStub();

    vi.stubGlobal("window", {
      localStorage: storage,
      matchMedia: vi.fn(() => ({ matches: false })),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("保存値がなければ既定で OFF を返す", () => {
    expect(loadDeveloperModeEnabled()).toBe(false);
    expect(window.localStorage.getItem(DEVELOPER_MODE_ENABLED_KEY)).toBeNull();
  });

  it("保存値をそのまま復元する", () => {
    saveDeveloperModeEnabled(true);

    expect(loadDeveloperModeEnabled()).toBe(true);
    expect(window.localStorage.getItem(DEVELOPER_MODE_ENABLED_KEY)).toBe("true");
  });
});

describe("clearAppStorage", () => {
  beforeEach(() => {
    const storage = createLocalStorageStub();

    vi.stubGlobal("window", {
      localStorage: storage,
      matchMedia: vi.fn(() => ({ matches: false })),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Yodaka 用の localStorage key だけを消去する", () => {
    saveRelaySettings([
      {
        url: "wss://yabu.me",
        enabled: true,
        read: true,
        write: true,
        nip65Managed: false,
      },
    ]);
    saveDeveloperModeEnabled(true);
    saveProfileImagesEnabled(true);
    saveThemePreference("dark");
    saveManualPubkey("f".repeat(64));
    window.localStorage.setItem("external-key", "keep");

    clearAppStorage();

    expect(window.localStorage.getItem(RELAY_SETTINGS_KEY)).toBeNull();
    expect(window.localStorage.getItem(RELAY_URLS_KEY)).toBeNull();
    expect(window.localStorage.getItem(DEVELOPER_MODE_ENABLED_KEY)).toBeNull();
    expect(window.localStorage.getItem(PROFILE_IMAGES_ENABLED_KEY)).toBeNull();
    expect(window.localStorage.getItem(THEME_PREFERENCE_KEY)).toBeNull();
    expect(window.localStorage.getItem(MANUAL_PUBKEY_KEY)).toBeNull();
    expect(window.localStorage.getItem("external-key")).toBe("keep");
    expect(loadDeveloperModeEnabled()).toBe(false);
    expect(loadProfileImagesEnabled()).toBe(false);
  });
});

describe("relay settings", () => {
  beforeEach(() => {
    const storage = createLocalStorageStub();

    vi.stubGlobal("window", {
      localStorage: storage,
      matchMedia: vi.fn(() => ({ matches: false })),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("保存した relay 順序をそのまま復元する", () => {
    saveRelaySettings([
      {
        url: "wss://nos.lol",
        enabled: true,
        read: true,
        write: true,
        nip65Managed: false,
      },
      {
        url: "wss://yabu.me",
        enabled: false,
        read: true,
        write: false,
        nip65Managed: true,
      },
      {
        url: "wss://relay.damus.io",
        enabled: true,
        read: false,
        write: true,
        nip65Managed: false,
      },
    ]);

    expect(loadRelaySettings()).toEqual([
      {
        url: "wss://nos.lol/",
        enabled: true,
        read: true,
        write: true,
        nip65Managed: false,
      },
      {
        url: "wss://yabu.me/",
        enabled: false,
        read: true,
        write: false,
        nip65Managed: true,
      },
      {
        url: "wss://relay.damus.io/",
        enabled: true,
        read: false,
        write: true,
        nip65Managed: false,
      },
    ]);
    expect(loadRelayUrls()).toEqual([
      "wss://nos.lol/",
      "wss://relay.damus.io/",
    ]);
  });

  it("旧 relay 設定は read/write 有効・nip65Managed 無効として移行する", () => {
    window.localStorage.setItem(
      "nostr-client.relay-settings",
      JSON.stringify([
        { url: "wss://nos.lol", enabled: true },
        { url: "wss://yabu.me", enabled: false },
      ]),
    );

    expect(loadRelaySettings()).toEqual([
      {
        url: "wss://nos.lol/",
        enabled: true,
        read: true,
        write: true,
        nip65Managed: false,
      },
      {
        url: "wss://yabu.me/",
        enabled: false,
        read: true,
        write: true,
        nip65Managed: false,
      },
    ]);
  });

  it("active/read/write relay を役割ごとに切り分ける", () => {
    const relaySettings = [
      {
        url: "wss://nos.lol",
        enabled: true,
        read: true,
        write: true,
        nip65Managed: false,
      },
      {
        url: "wss://relay.damus.io",
        enabled: true,
        read: true,
        write: false,
        nip65Managed: false,
      },
      {
        url: "wss://yabu.me",
        enabled: true,
        read: false,
        write: true,
        nip65Managed: false,
      },
      {
        url: "wss://r.kojira.io",
        enabled: true,
        read: false,
        write: false,
        nip65Managed: false,
      },
      {
        url: "wss://srtrelay.c-stellar.net",
        enabled: false,
        read: true,
        write: true,
        nip65Managed: false,
      },
    ];

    expect(listActiveRelayUrls(relaySettings)).toEqual([
      "wss://nos.lol/",
      "wss://relay.damus.io/",
      "wss://yabu.me/",
    ]);
    expect(listReadRelayUrls(relaySettings)).toEqual([
      "wss://nos.lol/",
      "wss://relay.damus.io/",
    ]);
    expect(listWriteRelayUrls(relaySettings)).toEqual([
      "wss://nos.lol/",
      "wss://yabu.me/",
    ]);
  });
});

function createLocalStorageStub() {
  const store = new Map<string, string>();

  return {
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}
