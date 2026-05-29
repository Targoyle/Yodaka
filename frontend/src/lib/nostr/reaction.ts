export const KUSA_REACTION_SHORTCODE = "kusa";
export const KUSA_REACTION_CONTENT = `:${KUSA_REACTION_SHORTCODE}:`;
export const KUSA_REACTION_IMAGE_URL =
  "https://image.nostr.build/18fa1ce2d056e3d28c05b566969ea7c0a8de4cf5c2cd9422242278ff53910a9d.png";

export type ReactionIntent = "like" | "kusa";

export function isLikeReactionContent(content: string) {
  return content === "" || content === "+";
}

export function isKusaReactionContent(content: string) {
  return content === KUSA_REACTION_CONTENT;
}

export function formatReactionContentLabel(content: string) {
  if (isLikeReactionContent(content)) {
    return "★";
  }

  if (isKusaReactionContent(content)) {
    return "草";
  }

  return content;
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
