import { describe, expect, it } from "vitest";
import { decodeNpub, decodeNsec, encodeNevent, encodeNpub, encodeNsec } from "./nip19";

describe("encodeNpub", () => {
  it("既知の公開鍵を npub へ変換できる", () => {
    expect(
      encodeNpub("aa4fc8665f5696e33db7e1a572e3b0f5b3d615837b0f362dcb1c8068b098c7b4"),
    ).toBe("npub14f8usejl26twx0dhuxjh9cas7keav9vr0v8nvtwtrjqx3vycc76qqh9nsy");
  });

  it("不正な入力は null を返す", () => {
    expect(encodeNpub("")).toBeNull();
    expect(encodeNpub("xyz")).toBeNull();
    expect(encodeNpub("aa4fc866")).toBeNull();
  });
});

describe("encodeNevent", () => {
  it("イベント ID を nevent 形式へ変換できる", () => {
    const eventId =
      "dbe57554549f92c08bea790b05dc37dec6f3373303123f9e231635ee594ceb6a";
    const encoded = encodeNevent(eventId);

    expect(encoded).toMatch(/^nevent1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/);
    expect(encodeNevent(eventId.toUpperCase())).toBe(encoded);
  });

  it("不正な入力は null を返す", () => {
    expect(encodeNevent("")).toBeNull();
    expect(encodeNevent("not-hex")).toBeNull();
    expect(encodeNevent("dbe57554")).toBeNull();
  });
});

describe("encodeNsec", () => {
  it("秘密鍵を nsec 形式へ変換できる", () => {
    const encoded = encodeNsec(
      "0000000000000000000000000000000000000000000000000000000000000001",
    );

    expect(encoded).toMatch(/^nsec1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/);
  });

  it("不正な入力は null を返す", () => {
    expect(encodeNsec("")).toBeNull();
    expect(encodeNsec("xyz")).toBeNull();
    expect(encodeNsec("aa4fc866")).toBeNull();
  });
});

describe("decodeNpub", () => {
  it("npub を hex 公開鍵へ戻せる", () => {
    const hex =
      "aa4fc8665f5696e33db7e1a572e3b0f5b3d615837b0f362dcb1c8068b098c7b4";
    const npub = encodeNpub(hex);

    expect(npub).not.toBeNull();
    expect(decodeNpub(npub ?? "")).toBe(hex);
    expect(decodeNpub(`nostr:${npub}`)).toBe(hex);
  });

  it("不正な npub は null を返す", () => {
    expect(decodeNpub("")).toBeNull();
    expect(decodeNpub("npub1invalid")).toBeNull();
    expect(decodeNpub("note1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqx0m5x9")).toBeNull();
  });
});

describe("decodeNsec", () => {
  it("nsec を hex 秘密鍵へ戻せる", () => {
    const hex =
      "0000000000000000000000000000000000000000000000000000000000000001";
    const nsec = encodeNsec(hex);

    expect(nsec).not.toBeNull();
    expect(decodeNsec(nsec ?? "")).toBe(hex);
    expect(decodeNsec(`nostr:${nsec}`)).toBe(hex);
  });

  it("不正な nsec は null を返す", () => {
    expect(decodeNsec("")).toBeNull();
    expect(decodeNsec("nsec1invalid")).toBeNull();
    expect(
      decodeNsec("npub14f8usejl26twx0dhuxjh9cas7keav9vr0v8nvtwtrjqx3vycc76qqh9nsy"),
    ).toBeNull();
  });
});
