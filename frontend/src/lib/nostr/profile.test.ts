import { describe, expect, it } from "vitest";
import {
  MAX_PROFILE_TEXT_LENGTH,
  sanitizeProfilePictureUrl,
  sanitizeProfileText,
} from "./profile";

describe("sanitizeProfilePictureUrl", () => {
  it("安全な https 絶対 URL を許可する", () => {
    expect(
      sanitizeProfilePictureUrl("https://cdn.example.com/avatar.png", {
        currentOrigin: "https://app.example.com",
      }),
    ).toBe("https://cdn.example.com/avatar.png");
  });

  it("相対 URL と http URL を拒否する", () => {
    expect(
      sanitizeProfilePictureUrl("/avatar.png", {
        currentOrigin: "https://app.example.com",
      }),
    ).toBeNull();
    expect(
      sanitizeProfilePictureUrl("http://cdn.example.com/avatar.png", {
        currentOrigin: "https://app.example.com",
      }),
    ).toBeNull();
    expect(
      sanitizeProfilePictureUrl("javascript:alert(1)", {
        currentOrigin: "https://app.example.com",
      }),
    ).toBeNull();
    expect(
      sanitizeProfilePictureUrl("data:image/svg+xml,<svg/onload=alert(1)>", {
        currentOrigin: "https://app.example.com",
      }),
    ).toBeNull();
  });

  it("同一オリジンとローカルアドレスを拒否する", () => {
    expect(
      sanitizeProfilePictureUrl("https://app.example.com/private.png", {
        currentOrigin: "https://app.example.com",
      }),
    ).toBeNull();
    expect(
      sanitizeProfilePictureUrl("https://127.0.0.1/avatar.png", {
        currentOrigin: "https://app.example.com",
      }),
    ).toBeNull();
    expect(
      sanitizeProfilePictureUrl("https://192.168.1.20/avatar.png", {
        currentOrigin: "https://app.example.com",
      }),
    ).toBeNull();
    expect(
      sanitizeProfilePictureUrl("https://localhost/avatar.png", {
        currentOrigin: "https://app.example.com",
      }),
    ).toBeNull();
    expect(
      sanitizeProfilePictureUrl("https://assets.local/avatar.png", {
        currentOrigin: "https://app.example.com",
      }),
    ).toBeNull();
  });
});

describe("sanitizeProfileText", () => {
  it("文字列以外と空文字を拒否する", () => {
    expect(sanitizeProfileText(null)).toBeNull();
    expect(sanitizeProfileText(123)).toBeNull();
    expect(sanitizeProfileText("   ")).toBeNull();
  });

  it("制御文字を除去して trim する", () => {
    expect(sanitizeProfileText(" \u0000Alice\u0007 \n")).toBe("Alice");
  });

  it("長すぎるプロフィール文字列を切り詰める", () => {
    const longValue = "a".repeat(MAX_PROFILE_TEXT_LENGTH + 20);

    expect(sanitizeProfileText(longValue)).toBe(
      "a".repeat(MAX_PROFILE_TEXT_LENGTH),
    );
  });
});
