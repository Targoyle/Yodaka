import { describe, expect, it } from "vitest";
import {
  buildMiningPatternConfig,
  describeMiningAffixLengthNote,
  getAffixValidationError,
  MAX_GPU_PREFIX_AFFIX_LENGTH,
  MAX_GPU_SUFFIX_AFFIX_LENGTH,
  MAX_GPU_TOTAL_AFFIX_WINDOW,
  MAX_MINING_AFFIX_LENGTH,
  matchesNpubAffixes,
  normalizeMiningRequest,
  prefixToPreviewHex,
} from "./affix";
import { encodeNpub } from "../nostr/nip19";

describe("normalizeMiningRequest", () => {
  it("prefix または suffix があれば正規化できる", () => {
    expect(
      normalizeMiningRequest({
        prefix: " m0ctane ",
        suffix: "",
      }),
    ).toEqual({
      prefix: "m0ctane",
      suffix: "",
    });
  });

  it("両方空だと失敗する", () => {
    expect(() =>
      normalizeMiningRequest({
        prefix: "",
        suffix: "",
      }),
    ).toThrow("prefix または suffix を入力してください");
  });

  it("bech32 以外の文字を拒否する", () => {
    expect(() =>
      normalizeMiningRequest({
        prefix: "test1",
        suffix: "",
      }),
    ).toThrow("区切り文字のため予約されています");
    expect(() =>
      normalizeMiningRequest({
        prefix: "SATOSHI",
        suffix: "",
      }),
    ).toThrow("bech32 の小文字のみ");
  });

  it("npub payload 長までは受け付ける", () => {
    expect(
      normalizeMiningRequest({
        prefix: "q".repeat(MAX_MINING_AFFIX_LENGTH),
        suffix: "",
      }),
    ).toEqual({
      prefix: "q".repeat(MAX_MINING_AFFIX_LENGTH),
      suffix: "",
    });
  });

  it("npub payload 長を超える入力を拒否する", () => {
    expect(() =>
      normalizeMiningRequest({
        prefix: "q".repeat(MAX_MINING_AFFIX_LENGTH + 1),
        suffix: "",
      }),
    ).toThrow(`${MAX_MINING_AFFIX_LENGTH} 文字以内`);
  });
});

describe("buildMiningPatternConfig", () => {
  it("空の affix は disabled として扱う", () => {
    expect(
      buildMiningPatternConfig({
        prefix: "",
        suffix: "cafe",
      }),
    ).toMatchObject({
      prefixEnabled: false,
      prefixPattern32: 0,
      prefixMask32: 0,
      suffixEnabled: true,
    });
  });

  it("長い affix では GPU が見られる範囲だけを事前判定に使う", () => {
    const prefix = "qpzry9x8gf2tvdw0";
    const suffix = "0s3jn54khce6mua7lqp";

    expect(
      buildMiningPatternConfig({
        prefix,
        suffix,
      }),
    ).toEqual(
      buildMiningPatternConfig({
        prefix: prefix.slice(0, MAX_GPU_PREFIX_AFFIX_LENGTH),
        suffix: suffix.slice(-MAX_GPU_SUFFIX_AFFIX_LENGTH),
      }),
    );
  });
});

describe("matchesNpubAffixes", () => {
  it("payload 部分で prefix / suffix を判定する", () => {
    const npub =
      "npub14f8usejl26twx0dhuxjh9cas7keav9vr0v8nvtwtrjqx3vycc76qqh9nsy";

    expect(
      matchesNpubAffixes(npub, {
        prefix: "4f8u",
        suffix: "h9nsy",
      }),
    ).toBe(true);
    expect(
      matchesNpubAffixes(npub, {
        prefix: "wrong",
        suffix: "",
      }),
    ).toBe(false);
  });
});

describe("prefixToPreviewHex", () => {
  it("5文字以上の prefix では対応する先頭 6 hex を返す", () => {
    const pubkeyHex =
      "6f5b4b1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    const npub = encodeNpub(pubkeyHex);

    expect(npub).not.toBeNull();
    expect(prefixToPreviewHex(npub!.slice(5, 10))).toBe("#6f5b4b");
  });

  it("短い prefix では未確定 bits を 0 埋めした 6 hex を返す", () => {
    expect(prefixToPreviewHex("l")).toBe("#f80000");
  });

  it("長い prefix でも先頭側だけで preview を作れる", () => {
    expect(() => prefixToPreviewHex("qpzry9x8gf2tvdw0s3jn54")).not.toThrow();
  });
});

describe("getAffixValidationError", () => {
  it("有効な affix では null を返す", () => {
    expect(getAffixValidationError("hawk", "suffix")).toBeNull();
  });

  it("不正文字の説明を返す", () => {
    expect(getAffixValidationError("y0daka!", "prefix")).toContain(
      "prefix に '!' は使えません",
    );
  });
});

describe("describeMiningAffixLengthNote", () => {
  it("判定窓内では補足メッセージを出さない", () => {
    expect(describeMiningAffixLengthNote(MAX_GPU_TOTAL_AFFIX_WINDOW)).toBeNull();
  });

  it("判定窓を超えると計算非対応を返す", () => {
    expect(describeMiningAffixLengthNote(MAX_GPU_TOTAL_AFFIX_WINDOW + 1)).toBe(
      "計算非対応です。",
    );
  });

  it("最大長ちょうどでは最大長メッセージを返す", () => {
    expect(describeMiningAffixLengthNote(MAX_MINING_AFFIX_LENGTH)).toBe(
      "npub マイニング最大長です。",
    );
  });

  it("最大長超過では超過メッセージを返す", () => {
    expect(describeMiningAffixLengthNote(MAX_MINING_AFFIX_LENGTH + 1)).toBe(
      "npub 文字数を超えています。",
    );
  });
});
