import type { ReactionSummary } from "../wasm/client";

export const KUSA_REACTION_SHORTCODE = "kusa";
export const KUSA_REACTION_CONTENT = `:${KUSA_REACTION_SHORTCODE}:`;
export const KUSA_REACTION_IMAGE_URL =
  "https://image.nostr.build/18fa1ce2d056e3d28c05b566969ea7c0a8de4cf5c2cd9422242278ff53910a9d.png";

export type ReactionIntent = "like" | "kusa";
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

export function resolveReactionIntent(content: string): ReactionIntent | null {
  if (isLikeReactionContent(content)) {
    return "like";
  }

  if (isKusaReactionContent(content)) {
    return "kusa";
  }

  return null;
}

export function formatReactionContentLabel(content: string) {
  const reactionIntent = resolveReactionIntent(content);

  if (reactionIntent === "like") {
    return "★";
  }

  if (reactionIntent === "kusa") {
    return "草";
  }

  return content;
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

export function buildReactionContent(intent: ReactionIntent) {
  return intent === "kusa" ? KUSA_REACTION_CONTENT : "";
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
