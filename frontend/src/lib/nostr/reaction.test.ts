import { describe, expect, it } from "vitest";
import {
  buildReactionContent,
  buildReactionCustomEmojiTags,
  formatReactionContentLabel,
  KUSA_REACTION_CONTENT,
  KUSA_REACTION_IMAGE_URL,
  KUSA_REACTION_SHORTCODE,
} from "./reaction";

describe("reaction helpers", () => {
  it("like は星表示と空 content を使う", () => {
    expect(buildReactionContent("like")).toBe("");
    expect(buildReactionCustomEmojiTags("like")).toEqual([]);
    expect(formatReactionContentLabel("")).toBe("★");
    expect(formatReactionContentLabel("+")).toBe("★");
  });

  it("kusa は shortcode content と emoji tag を使う", () => {
    expect(buildReactionContent("kusa")).toBe(KUSA_REACTION_CONTENT);
    expect(buildReactionCustomEmojiTags("kusa")).toEqual([
      ["emoji", KUSA_REACTION_SHORTCODE, KUSA_REACTION_IMAGE_URL],
    ]);
    expect(formatReactionContentLabel(KUSA_REACTION_CONTENT)).toBe("草");
  });

  it("その他のリアクションは content をそのまま表示する", () => {
    expect(formatReactionContentLabel("🔥")).toBe("🔥");
  });
});
