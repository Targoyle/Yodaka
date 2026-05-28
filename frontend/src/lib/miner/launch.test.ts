import { describe, expect, it } from "vitest";
import {
  buildKeyMinerOpenLocation,
  resolveKeyMinerLaunchFromLocation,
  stripKeyMinerLaunchFromLocation,
} from "./launch";

describe("resolveKeyMinerLaunchFromLocation", () => {
  it("query string の prefix / suffix で Key Miner を直接開く", () => {
    const config = resolveKeyMinerLaunchFromLocation(
      new URL("https://example.com/yodaka/?prefix=y0daka&suffix=hawk"),
    );

    expect(config).toEqual({
      open: true,
      prefix: "y0daka",
      suffix: "hawk",
    });
  });

  it("サブディレクトリ配下の miner path から prefix / suffix を読む", () => {
    const config = resolveKeyMinerLaunchFromLocation(
      new URL("https://example.com/app/releases/miner/y0daka/hawk"),
    );

    expect(config).toEqual({
      open: true,
      prefix: "y0daka",
      suffix: "hawk",
    });
  });

  it("prefix / suffix ラベル付き path を解釈する", () => {
    const config = resolveKeyMinerLaunchFromLocation(
      new URL("https://example.com/sub/key-miner/prefix/y0daka/suffix/hawk"),
    );

    expect(config).toEqual({
      open: true,
      prefix: "y0daka",
      suffix: "hawk",
    });
  });

  it("末尾 slash なしの miner path でも開く", () => {
    const config = resolveKeyMinerLaunchFromLocation(
      new URL("https://example.com/nostr/miner"),
    );

    expect(config).toEqual({
      open: true,
      prefix: "",
      suffix: "",
    });
  });

  it("query string は path より優先する", () => {
    const config = resolveKeyMinerLaunchFromLocation(
      new URL("https://example.com/app/miner/oldprefix/oldsuffix?prefix=y0daka"),
    );

    expect(config).toEqual({
      open: true,
      prefix: "y0daka",
      suffix: "oldsuffix",
    });
  });

  it("miner 指定がない通常 path では開かない", () => {
    const config = resolveKeyMinerLaunchFromLocation(
      new URL("https://example.com/app/relay"),
    );

    expect(config).toEqual({
      open: false,
      prefix: "",
      suffix: "",
    });
  });
});

describe("stripKeyMinerLaunchFromLocation", () => {
  it("サブディレクトリ配下の miner path を通常 path に戻す", () => {
    expect(
      stripKeyMinerLaunchFromLocation(
        new URL("https://example.com/app/releases/miner/y0daka/hawk"),
      ),
    ).toBe("/app/releases/");
  });

  it("launch 用 query を消しつつ他の query と hash を残す", () => {
    expect(
      stripKeyMinerLaunchFromLocation(
        new URL("https://example.com/app/miner/y0daka?prefix=y0daka&suffix=hawk&tab=relay#debug"),
      ),
    ).toBe("/app/?tab=relay#debug");
  });

  it("末尾 slash なしの miner path を通常 path に戻す", () => {
    expect(
      stripKeyMinerLaunchFromLocation(
        new URL("https://example.com/nostr/miner"),
      ),
    ).toBe("/nostr/");
  });
});

describe("buildKeyMinerOpenLocation", () => {
  it("通常 path に /miner を付ける", () => {
    expect(
      buildKeyMinerOpenLocation(
        new URL("https://example.com/app/releases/?tab=relay#debug"),
      ),
    ).toBe("/app/releases/miner?tab=relay#debug");
  });

  it("既存の miner path から重複せず正規化する", () => {
    expect(
      buildKeyMinerOpenLocation(
        new URL("https://example.com/app/miner/y0daka/hawk?prefix=y0daka&tab=relay"),
      ),
    ).toBe("/app/miner?tab=relay");
  });
});
