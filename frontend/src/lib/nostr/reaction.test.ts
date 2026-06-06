import { describe, expect, it } from "vitest";
import {
  buildReactionContent,
  buildReactionCustomEmojiTags,
  formatCollapsedReactionSummary,
  formatReactionContentLabel,
  isCustomEmojiReactionContent,
  KUSA_REACTION_CONTENT,
  KUSA_REACTION_IMAGE_URL,
  KUSA_REACTION_SHORTCODE,
  resolveReactionIntent,
} from "./reaction";

describe("reaction helpers", () => {
  it("like は星表示と空 content を使う", () => {
    expect(buildReactionContent("like")).toBe("");
    expect(buildReactionCustomEmojiTags("like")).toEqual([]);
    expect(resolveReactionIntent("")).toBe("like");
    expect(resolveReactionIntent("+")).toBe("like");
    expect(formatReactionContentLabel("")).toBe("★");
    expect(formatReactionContentLabel("+")).toBe("★");
  });

  it("kusa は shortcode content と emoji tag を使う", () => {
    expect(buildReactionContent("kusa")).toBe(KUSA_REACTION_CONTENT);
    expect(buildReactionCustomEmojiTags("kusa")).toEqual([
      ["emoji", KUSA_REACTION_SHORTCODE, KUSA_REACTION_IMAGE_URL],
    ]);
    expect(resolveReactionIntent(KUSA_REACTION_CONTENT)).toBe("kusa");
    expect(formatReactionContentLabel(KUSA_REACTION_CONTENT)).toBe("草");
  });

  it("その他のリアクションは content をそのまま表示する", () => {
    expect(isCustomEmojiReactionContent(":wakaru:")).toBe(true);
    expect(isCustomEmojiReactionContent("🔥")).toBe(false);
    expect(resolveReactionIntent("🔥")).toBeNull();
    expect(formatReactionContentLabel("🔥")).toBe("🔥");
  });

  it("折りたたみリアクション表示は先頭の絵文字を出し、残りがあれば省略記号を付ける", () => {
    expect(
      formatCollapsedReactionSummary([
        { content: "🔥", count: 1 },
      ]),
    ).toBe("🔥");
    expect(
      formatCollapsedReactionSummary([
        { content: "🔥", count: 2 },
      ]),
    ).toBe("🔥...");
    expect(
      formatCollapsedReactionSummary([
        { content: "🔥", count: 1 },
        { content: "🚀", count: 1 },
      ]),
    ).toBe("🔥...");
    expect(
      formatCollapsedReactionSummary([
        { content: ":wakaru:", count: 1 },
      ]),
    ).toBe("■");
    expect(
      formatCollapsedReactionSummary([
        { content: ":wakaru:", count: 2 },
      ]),
    ).toBe("■...");
  });
});
