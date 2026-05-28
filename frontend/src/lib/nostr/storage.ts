import { normalizeRelayUrl, normalizeRelayUrls } from "./relayUrl";

const RELAY_URLS_KEY = "nostr-client.relay-urls";
const RELAY_SETTINGS_KEY = "nostr-client.relay-settings";
const PROFILE_IMAGES_ENABLED_KEY = "nostr-client.profile-images-enabled";
const DEVELOPER_MODE_ENABLED_KEY = "nostr-client.developer-mode-enabled";
const THEME_PREFERENCE_KEY = "nostr-client.theme-preference";
const MANUAL_PUBKEY_KEY = "nostr-client.manual-pubkey";
const APP_STORAGE_KEYS = [
  RELAY_URLS_KEY,
  RELAY_SETTINGS_KEY,
  PROFILE_IMAGES_ENABLED_KEY,
  DEVELOPER_MODE_ENABLED_KEY,
  THEME_PREFERENCE_KEY,
  MANUAL_PUBKEY_KEY,
] as const;

const LEGACY_DEFAULT_RELAY_URLS = ["wss://relay.damus.io"];
const PREVIOUS_DEFAULT_RELAY_URLS = ["wss://yabu.me"];
const RECENT_DEFAULT_RELAY_URLS = [
  "wss://yabu.me",
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://r.kojira.io",
  "wss://srtrelay.c-stellar.net",
];
const DEFAULT_RELAY_URLS = [...RECENT_DEFAULT_RELAY_URLS];
const DEFAULT_PROFILE_IMAGES_ENABLED = false;
const DEFAULT_DEVELOPER_MODE_ENABLED = false;

export type ThemePreference = "light" | "dark";
export type RelaySetting = {
  url: string;
  enabled: boolean;
  read: boolean;
  write: boolean;
  nip65Managed: boolean;
};

export function buildDefaultRelaySettings(): RelaySetting[] {
  return DEFAULT_RELAY_URLS.map((url) => buildRelaySetting(url));
}

export function loadRelaySettings(): RelaySetting[] {
  const rawSettings = window.localStorage.getItem(RELAY_SETTINGS_KEY);

  if (rawSettings) {
    try {
      const parsed = JSON.parse(rawSettings) as RelaySetting[];
      const normalized = normalizeRelaySettings(parsed);

      if (normalized.length > 0) {
        return normalized;
      }
    } catch {
      return buildDefaultRelaySettings();
    }
  }

  const relayUrls = loadLegacyRelayUrls();

  return relayUrls.map((url) => buildRelaySetting(url));
}

export function loadRelayUrls(): string[] {
  return listActiveRelayUrls(loadRelaySettings());
}

export function saveRelaySettings(relaySettings: RelaySetting[]) {
  const normalized = normalizeRelaySettings(relaySettings);
  const activeRelayUrls = listActiveRelayUrls(normalized);

  window.localStorage.setItem(RELAY_SETTINGS_KEY, JSON.stringify(normalized));
  window.localStorage.setItem(RELAY_URLS_KEY, JSON.stringify(activeRelayUrls));
}

export function saveRelayUrls(relayUrls: string[]) {
  saveRelaySettings(
    relayUrls.map((url) => ({
      url,
      enabled: true,
      read: true,
      write: true,
      nip65Managed: false,
    })),
  );
}

export function loadProfileImagesEnabled() {
  const raw = window.localStorage.getItem(PROFILE_IMAGES_ENABLED_KEY);

  if (raw === null) {
    return DEFAULT_PROFILE_IMAGES_ENABLED;
  }

  return raw === "true";
}

export function saveProfileImagesEnabled(enabled: boolean) {
  window.localStorage.setItem(PROFILE_IMAGES_ENABLED_KEY, String(enabled));
}

export function loadDeveloperModeEnabled() {
  const raw = window.localStorage.getItem(DEVELOPER_MODE_ENABLED_KEY);

  if (raw === null) {
    return DEFAULT_DEVELOPER_MODE_ENABLED;
  }

  return raw === "true";
}

export function saveDeveloperModeEnabled(enabled: boolean) {
  window.localStorage.setItem(DEVELOPER_MODE_ENABLED_KEY, String(enabled));
}

export function loadThemePreference(): ThemePreference {
  if (typeof window === "undefined") {
    return "light";
  }

  const raw = window.localStorage.getItem(THEME_PREFERENCE_KEY);

  if (raw === "light" || raw === "dark") {
    return raw;
  }

  const resolved = resolveSystemThemePreference();
  window.localStorage.setItem(THEME_PREFERENCE_KEY, resolved);
  return resolved;
}

export function saveThemePreference(preference: ThemePreference) {
  window.localStorage.setItem(THEME_PREFERENCE_KEY, preference);
}

export function loadManualPubkey() {
  return window.localStorage.getItem(MANUAL_PUBKEY_KEY);
}

export function saveManualPubkey(pubkey: string) {
  window.localStorage.setItem(MANUAL_PUBKEY_KEY, pubkey);
}

export function clearManualPubkey() {
  window.localStorage.removeItem(MANUAL_PUBKEY_KEY);
}

export function clearAppStorage() {
  for (const key of APP_STORAGE_KEYS) {
    window.localStorage.removeItem(key);
  }
}

export function listActiveRelayUrls(relaySettings: RelaySetting[]) {
  return normalizeRelayUrls(
    relaySettings
      .filter((setting) => setting.enabled && (setting.read || setting.write))
      .map((setting) => setting.url),
  );
}

export function listReadRelayUrls(relaySettings: RelaySetting[]) {
  return normalizeRelayUrls(
    relaySettings
      .filter((setting) => setting.enabled && setting.read)
      .map((setting) => setting.url),
  );
}

export function listWriteRelayUrls(relaySettings: RelaySetting[]) {
  return normalizeRelayUrls(
    relaySettings
      .filter((setting) => setting.enabled && setting.write)
      .map((setting) => setting.url),
  );
}

function loadLegacyRelayUrls() {
  const raw = window.localStorage.getItem(RELAY_URLS_KEY);

  if (!raw) {
    return DEFAULT_RELAY_URLS;
  }

  try {
    const parsed = JSON.parse(raw) as string[];

    if (parsed.length === 0) {
      return DEFAULT_RELAY_URLS;
    }

    if (
      isLegacyDefaultRelayUrls(parsed) ||
      isPreviousDefaultRelayUrls(parsed) ||
      isRecentDefaultRelayUrls(parsed)
    ) {
      return DEFAULT_RELAY_URLS;
    }

    return normalizeRelayUrls(parsed);
  } catch {
    return DEFAULT_RELAY_URLS;
  }
}

function buildRelaySetting(
  url: string,
  overrides: Partial<Omit<RelaySetting, "url">> = {},
): RelaySetting {
  const normalizedUrl = normalizeRelayUrl(url) ?? url;

  return {
    url: normalizedUrl,
    enabled: typeof overrides.enabled === "boolean" ? overrides.enabled : true,
    read: typeof overrides.read === "boolean" ? overrides.read : true,
    write: typeof overrides.write === "boolean" ? overrides.write : true,
    nip65Managed: overrides.nip65Managed === true,
  };
}

function normalizeRelaySettings(
  relaySettings: Array<Partial<RelaySetting> & { url?: string }>,
) {
  const relayMap = new Map<string, RelaySetting>();

  for (const relaySetting of relaySettings) {
    const normalizedUrl = normalizeRelayUrl(relaySetting.url);

    if (!normalizedUrl) {
      continue;
    }

    relayMap.set(
      normalizedUrl,
      buildRelaySetting(normalizedUrl, {
        enabled: relaySetting.enabled,
        read: relaySetting.read,
        write: relaySetting.write,
        nip65Managed: relaySetting.nip65Managed,
      }),
    );
  }

  if (relayMap.size === 0) {
    return buildDefaultRelaySettings();
  }

  return [...relayMap.values()];
}

function isLegacyDefaultRelayUrls(relayUrls: string[]) {
  return (
    relayUrls.length === LEGACY_DEFAULT_RELAY_URLS.length &&
    relayUrls.every((relayUrl, index) => relayUrl === LEGACY_DEFAULT_RELAY_URLS[index])
  );
}

function isPreviousDefaultRelayUrls(relayUrls: string[]) {
  return (
    relayUrls.length === PREVIOUS_DEFAULT_RELAY_URLS.length &&
    relayUrls.every((relayUrl, index) => relayUrl === PREVIOUS_DEFAULT_RELAY_URLS[index])
  );
}

function isRecentDefaultRelayUrls(relayUrls: string[]) {
  return (
    relayUrls.length === RECENT_DEFAULT_RELAY_URLS.length &&
    relayUrls.every((relayUrl, index) => relayUrl === RECENT_DEFAULT_RELAY_URLS[index])
  );
}

function resolveSystemThemePreference(): ThemePreference {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}
