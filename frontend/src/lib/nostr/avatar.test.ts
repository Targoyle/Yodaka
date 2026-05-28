import { describe, expect, it } from "vitest";
import { formatAvatarFallbackLabel } from "./avatar";

describe("formatAvatarFallbackLabel", () => {
  it("ASCII 文字は大文字で返す", () => {
    expect(formatAvatarFallbackLabel("sad but sweet")).toBe("S");
  });

  it("BMP 外の装飾文字も壊さず返す", () => {
    expect(formatAvatarFallbackLabel("𝙨𝙖𝙙 𝙗𝙪𝙩 𝙨𝙬𝙚𝙚𝙩")).toBe("𝙨");
  });

  it("先頭が空白でも最初の書記素を返す", () => {
    expect(formatAvatarFallbackLabel("  😺 cat")).toBe("😺");
  });

  it("空文字は既定値を返す", () => {
    expect(formatAvatarFallbackLabel("   ")).toBe("#");
  });
});
