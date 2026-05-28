import type { CSSProperties } from "react";

export function buildAvatarStyle(pubkey: string): CSSProperties {
  const backgroundColor = pubkeyHexColor(pubkey);

  return {
    background: backgroundColor,
    color: avatarTextColor(backgroundColor),
  };
}

export function pubkeyHexColor(pubkey: string) {
  const normalized = pubkey.toLowerCase().replace(/[^0-9a-f]/g, "");
  const hex = normalized.slice(0, 6).padEnd(6, "0");

  return `#${hex || "6f5b4b"}`;
}

export function avatarTextColor(backgroundHex: string) {
  const red = Number.parseInt(backgroundHex.slice(1, 3), 16);
  const green = Number.parseInt(backgroundHex.slice(3, 5), 16);
  const blue = Number.parseInt(backgroundHex.slice(5, 7), 16);
  const luminance = (red * 299 + green * 587 + blue * 114) / 1000;

  return luminance >= 150 ? "#0f1418" : "#fffaf2";
}
