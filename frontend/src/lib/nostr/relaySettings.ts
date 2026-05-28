import { normalizeRelayUrls } from "./contacts";
import type { RelaySetting } from "./storage";

export function loadAccountRelayUrls(relayUrls: string[]) {
  return normalizeRelayUrls(relayUrls);
}

export function moveRelaySettings(
  relaySettings: RelaySetting[],
  relayUrl: string,
  direction: -1 | 1,
) {
  const index = relaySettings.findIndex((setting) => setting.url === relayUrl);

  if (index < 0) {
    return relaySettings;
  }

  const nextIndex = index + direction;

  if (nextIndex < 0 || nextIndex >= relaySettings.length) {
    return relaySettings;
  }

  const next = [...relaySettings];
  const [moved] = next.splice(index, 1);

  next.splice(nextIndex, 0, moved);
  return next;
}
