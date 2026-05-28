import type { ThemePreference } from "../nostr/storage";

export function cycleThemePreference(preference: ThemePreference): ThemePreference {
  switch (preference) {
    case "light":
      return "dark";

    case "dark":
      return "light";
  }
}

export function buildThemePreferenceIndicator(preference: ThemePreference) {
  switch (preference) {
    case "light":
      return {
        icon: "☀",
        title: "ライトテーマ。クリックでダークテーマへ切替",
      };

    case "dark":
      return {
        icon: "☾",
        title: "ダークテーマ。クリックでライトテーマへ切替",
      };
  }
}
