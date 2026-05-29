import { describe, expect, it } from "vitest";
import {
  formatRelayAccessLabel,
  formatRelayAccessMessage,
  parseRelayAuthMessage,
} from "./relayAuth";

describe("relayAuth", () => {
  it("auth-required を機械可読 prefix として解釈できる", () => {
    expect(parseRelayAuthMessage("auth-required: login first")).toEqual({
      requirement: "auth-required",
      detail: "login first",
      raw: "auth-required: login first",
    });
    expect(formatRelayAccessMessage("auth-required: login first")).toBe(
      "relay が認証を要求しています: login first",
    );
    expect(formatRelayAccessLabel("auth-required: login first", "直近 publish 失敗")).toBe(
      "直近 publish 失敗 認証要求",
    );
  });

  it("restricted を機械可読 prefix として解釈できる", () => {
    expect(parseRelayAuthMessage("restricted: whitelisted users only")).toEqual({
      requirement: "restricted",
      detail: "whitelisted users only",
      raw: "restricted: whitelisted users only",
    });
    expect(formatRelayAccessMessage("restricted: whitelisted users only")).toBe(
      "relay がこの鍵を制限しています: whitelisted users only",
    );
  });

  it("通常メッセージはそのまま扱う", () => {
    expect(parseRelayAuthMessage("rate-limited")).toEqual({
      requirement: null,
      detail: "rate-limited",
      raw: "rate-limited",
    });
    expect(formatRelayAccessMessage("rate-limited")).toBe("rate-limited");
    expect(formatRelayAccessLabel("rate-limited", "直近 CLOSED")).toBe("直近 CLOSED");
  });
});
