import { formatAvatarFallbackLabel } from "./avatar";
import { encodeNpub } from "./nip19";
import { sanitizeProfilePictureUrl, sanitizeProfileText } from "./profile";
import type { TimelineItem, TimelineProfile } from "../wasm/client";
import { shortenBech32 } from "../ui/formatters";

export type ProfileSummaryVersion = {
  createdAt: number;
  eventId: string | null;
};

export function formatPubkey(pubkey: string) {
  return encodeNpub(pubkey) ?? pubkey;
}

export function formatAuthorLabel(item: TimelineItem, displayPubkey: string) {
  return item.profile?.displayName
    ?? item.profile?.name
    ?? shortenBech32(displayPubkey);
}

export function formatAuthorNameLabel(item: TimelineItem) {
  const displayName = item.profile?.displayName?.trim();
  const name = item.profile?.name?.trim();

  if (!displayName || !name) {
    return null;
  }

  if (normalizeAuthorNameValue(displayName) === normalizeAuthorNameValue(name)) {
    return null;
  }

  return name.startsWith("@") ? name : `@${name}`;
}

export function formatAuthorSubLabel(item: TimelineItem, displayPubkey: string) {
  if (!item.profile?.displayName && !item.profile?.name) {
    return null;
  }

  return shortenBech32(displayPubkey);
}

export function formatReplyTargetLabel(item: TimelineItem) {
  if (!item.replyTargetPubkey) {
    return null;
  }

  const displayPubkey = formatPubkey(item.replyTargetPubkey);

  return item.replyTargetProfile?.displayName
    ?? item.replyTargetProfile?.name
    ?? shortenBech32(displayPubkey);
}

export function formatRepostTargetLabel(item: TimelineItem) {
  if (!item.repostTargetPubkey) {
    return null;
  }

  const displayPubkey = formatPubkey(item.repostTargetPubkey);

  return item.repostTargetProfile?.displayName
    ?? item.repostTargetProfile?.name
    ?? shortenBech32(displayPubkey);
}

export function formatReplyContextLabel(item: TimelineItem) {
  const replyTargetLabel = formatReplyTargetLabel(item);

  if (replyTargetLabel) {
    return `${replyTargetLabel} へのリプライ`;
  }

  if (item.isReply && item.replyContextPubkeys.length > 0) {
    return "返信";
  }

  return null;
}

export function formatRepostContextLabel(item: TimelineItem) {
  if (item.kind !== 6) {
    return null;
  }

  return `${formatAuthorLabel(item, formatPubkey(item.pubkey))} がリポスト`;
}

export function formatAvatarLabel(item: TimelineItem, displayPubkey: string) {
  const source =
    item.profile?.displayName
    ?? item.profile?.name
    ?? displayPubkey;

  return formatAvatarFallbackLabel(source);
}

export function normalizeAuthorNameValue(value: string) {
  return value.trim().replace(/^@+/, "").toLocaleLowerCase();
}

export function parseProfileSummary(content: string): TimelineProfile | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const name = sanitizeProfileText(parsed.name);
    const displayName =
      sanitizeProfileText(parsed.display_name)
      ?? sanitizeProfileText(parsed.displayName);
    const picture = sanitizeProfilePictureUrl(
      typeof parsed.picture === "string" ? parsed.picture : null,
    );

    if (!name && !displayName && !picture) {
      return null;
    }

    return {
      name,
      displayName,
      picture,
    };
  } catch {
    return null;
  }
}

export function profilesEqual(
  left: TimelineProfile | null | undefined,
  right: TimelineProfile | null | undefined,
) {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.name === right.name
    && left.displayName === right.displayName
    && left.picture === right.picture
  );
}

export function shouldReplaceProfileSummaryVersion(
  current: ProfileSummaryVersion | null | undefined,
  next: ProfileSummaryVersion,
) {
  if (!current) {
    return true;
  }

  if (current.createdAt !== next.createdAt) {
    return current.createdAt < next.createdAt;
  }

  return (current.eventId ?? "") < (next.eventId ?? "");
}
