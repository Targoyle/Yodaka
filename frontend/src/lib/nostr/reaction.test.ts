import { describe, expect, it } from "vitest";
import {
  buildEmojiReactionIntent,
  buildReactionContent,
  buildReactionCustomEmojiTags,
  DEFAULT_EMOJI_REVOLVER,
  formatCollapsedReactionSummary,
  formatReactionContentLabel,
  isCustomEmojiReactionContent,
  KUSA_REACTION_CONTENT,
  KUSA_REACTION_IMAGE_URL,
  KUSA_REACTION_SHORTCODE,
  normalizeEmojiRevolver,
  normalizeEmojiRevolverEntry,
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

  it("追加リアクションは絵文字を intent として扱う", () => {
    expect(resolveReactionIntent("🔥")).toBe(buildEmojiReactionIntent("🔥"));
    expect(buildReactionContent(buildEmojiReactionIntent("🚀"))).toBe("🚀");
    expect(formatReactionContentLabel("🙏")).toBe("🙏");
  });

  it("絵文字レボルバ入力は 1 絵文字ずつ正規化する", () => {
    expect(DEFAULT_EMOJI_REVOLVER).toEqual(["👀", "🎉", "🥺", "🙏", "🌵", "💯"]);
    expect(normalizeEmojiRevolverEntry(" 👀 ")).toBe("👀");
    expect(normalizeEmojiRevolverEntry("ab")).toBeNull();
    expect(normalizeEmojiRevolver(["👀", "🎉", "👀", "🙏", "", "💯", "🌵", "🚀"])).toEqual([
      "👀",
      "🎉",
      "🙏",
      "💯",
      "🌵",
      "🚀",
    ]);
  });

  it("その他のリアクションは content をそのまま表示する", () => {
    expect(isCustomEmojiReactionContent(":wakaru:")).toBe(true);
    expect(isCustomEmojiReactionContent("🔥")).toBe(false);
    expect(resolveReactionIntent("text")).toBeNull();
    expect(formatReactionContentLabel("text")).toBe("text");
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
