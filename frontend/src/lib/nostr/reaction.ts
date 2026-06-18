import type { ReactionSummary } from "../wasm/client";

export const KUSA_REACTION_SHORTCODE = "kusa";
export const KUSA_REACTION_CONTENT = `:${KUSA_REACTION_SHORTCODE}:`;
export const KUSA_REACTION_IMAGE_URL =
  "https://image.nostr.build/18fa1ce2d056e3d28c05b566969ea7c0a8de4cf5c2cd9422242278ff53910a9d.png";
export const DEFAULT_EMOJI_REVOLVER = [
  "👀",
  "🎉",
  "🥺",
  "🙏",
  "🌵",
  "💯",
] as const;
export const MIN_EMOJI_REVOLVER_SIZE = 1;
export const MAX_EMOJI_REVOLVER_SIZE = 7;

export type EmojiReactionIntent = `emoji:${string}`;
export type ReactionIntent = "like" | "kusa" | EmojiReactionIntent;
export type ViewerTrackedReactionIntent = Extract<ReactionIntent, "like" | "kusa">;
export type ViewerReactionState = {
  like: boolean;
  kusa: boolean;
};

export function isLikeReactionContent(content: string) {
  return content === "" || content === "+";
}

export function isKusaReactionContent(content: string) {
  return content === KUSA_REACTION_CONTENT;
}

export function isCustomEmojiReactionContent(content: string) {
  return /^:[^\s:]+:$/u.test(content);
}

export function normalizeEmojiRevolverEntry(value: string) {
  const trimmed = value.trim();

  if (!trimmed || countGraphemeClusters(trimmed) !== 1) {
    return null;
  }

  return trimmed;
}

export function normalizeEmojiRevolver(
  values: readonly string[],
  limit = MAX_EMOJI_REVOLVER_SIZE,
) {
  const next: string[] = [];

  for (const value of values) {
    const normalized = normalizeEmojiRevolverEntry(value);

    if (!normalized || next.includes(normalized)) {
      continue;
    }

    next.push(normalized);

    if (next.length >= limit) {
      break;
    }
  }

  return next;
}

export function buildEmojiReactionIntent(emoji: string): EmojiReactionIntent {
  return `emoji:${emoji}`;
}

export function parseEmojiReactionIntent(intent: ReactionIntent) {
  return intent.startsWith("emoji:") ? intent.slice("emoji:".length) : null;
}

export function isEmojiReactionIntent(intent: ReactionIntent): intent is EmojiReactionIntent {
  return intent.startsWith("emoji:");
}

export function resolveReactionIntent(content: string): ReactionIntent | null {
  if (isLikeReactionContent(content)) {
    return "like";
  }

  if (isKusaReactionContent(content)) {
    return "kusa";
  }

  const normalizedEmoji = normalizeEmojiRevolverEntry(content);
  return normalizedEmoji ? buildEmojiReactionIntent(normalizedEmoji) : null;
}

export function isViewerTrackedReactionIntent(
  reactionIntent: ReactionIntent,
): reactionIntent is ViewerTrackedReactionIntent {
  return reactionIntent === "like" || reactionIntent === "kusa";
}

export function buildReactionLabel(intent: ReactionIntent) {
  if (intent === "like") {
    return "★";
  }

  if (intent === "kusa") {
    return "草";
  }

  return parseEmojiReactionIntent(intent) ?? "";
}

export function buildReactionTitle(intent: ReactionIntent) {
  if (intent === "like") {
    return "ふぁぼ";
  }

  if (intent === "kusa") {
    return "草";
  }

  return parseEmojiReactionIntent(intent) ?? "絵文字";
}

export function formatReactionContentLabel(content: string) {
  const reactionIntent = resolveReactionIntent(content);

  if (!reactionIntent) {
    return content;
  }

  return buildReactionLabel(reactionIntent);
}

export function buildReactionContent(intent: ReactionIntent) {
  if (intent === "kusa") {
    return KUSA_REACTION_CONTENT;
  }

  if (intent === "like") {
    return "";
  }

  return parseEmojiReactionIntent(intent) ?? "";
}

export function buildReactionCustomEmojiTags(intent: ReactionIntent): string[][] {
  if (intent !== "kusa") {
    return [];
  }

  return [[
    "emoji",
    KUSA_REACTION_SHORTCODE,
    KUSA_REACTION_IMAGE_URL,
  ]];
}

export function formatCollapsedReactionSummary(
  summaries: ReadonlyArray<ReactionSummary>,
  totalCount?: number,
) {
  const resolvedTotalCount =
    totalCount
    ?? summaries.reduce((count, summary) => count + summary.count, 0);
  const firstSummary = summaries[0];

  if (!firstSummary) {
    return resolvedTotalCount > 0 ? `more ${resolvedTotalCount}` : "";
  }

  const label = isCustomEmojiReactionContent(firstSummary.content)
    ? "■"
    : formatReactionContentLabel(firstSummary.content);

  return resolvedTotalCount > 1 ? `${label}...` : label;
}

function countGraphemeClusters(value: string) {
  if (
    typeof Intl !== "undefined"
    && "Segmenter" in Intl
  ) {
    return [
      ...new Intl.Segmenter("ja-JP", { granularity: "grapheme" }).segment(value),
    ].length;
  }

  return Array.from(value).length;
}
