import { describe, expect, it } from "vitest";
import {
  decodeNaddr,
  decodeNevent,
  decodeNote,
  decodeNprofile,
  decodeNpub,
  decodeNsec,
  encodeNevent,
  encodeNote,
  encodeNpub,
  encodeNsec,
} from "./nip19";

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

describe("encodeNote", () => {
  it("イベント ID を note 形式へ変換できる", () => {
    const eventId =
      "dbe57554549f92c08bea790b05dc37dec6f3373303123f9e231635ee594ceb6a";
    const encoded = encodeNote(eventId);

    expect(encoded).toMatch(/^note1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/);
    expect(encodeNote(eventId.toUpperCase())).toBe(encoded);
  });
});

describe("decodeNevent", () => {
  it("nevent を event id へ戻せる", () => {
    const eventId =
      "dbe57554549f92c08bea790b05dc37dec6f3373303123f9e231635ee594ceb6a";
    const nevent = encodeNevent(eventId);

    expect(nevent).not.toBeNull();
    expect(decodeNevent(nevent ?? "")).toEqual({
      eventId,
      relayUrls: [],
      authorPubkey: null,
    });
  });

  it("relay hint と author を含む nevent を読める", () => {
    expect(
      decodeNevent(
        "nevent1qqsqmjvzgayw2xfr4dcwlswu9zq45rjanpjqpk0qtar05aheda89ssgxykq0y",
      ),
    ).toEqual({
      eventId: "0dc9824748e51923ab70efc1dc28815a0e5d986400d9e05f46fa76f96f4e5841",
      relayUrls: [],
      authorPubkey: null,
    });
  });

  it("不正な nevent は null を返す", () => {
    expect(decodeNevent("")).toBeNull();
    expect(decodeNevent("nevent1invalid")).toBeNull();
    expect(
      decodeNevent("npub14f8usejl26twx0dhuxjh9cas7keav9vr0v8nvtwtrjqx3vycc76qqh9nsy"),
    ).toBeNull();
  });
});

describe("decodeNote", () => {
  it("note を event id へ戻せる", () => {
    const eventId =
      "dbe57554549f92c08bea790b05dc37dec6f3373303123f9e231635ee594ceb6a";
    const note = encodeNote(eventId);

    expect(note).not.toBeNull();
    expect(decodeNote(note ?? "")).toBe(eventId);
    expect(decodeNote(`nostr:${note}`)).toBe(eventId);
  });
});

describe("decodeNprofile", () => {
  it("nprofile から pubkey と relay hint を読める", () => {
    expect(
      decodeNprofile(
        "nprofile1qqszclxx9f5haga8sfjjrulaxncvkfekj097t6f3pu65f86rvg49ehqj6f9dh",
      ),
    ).toEqual({
      pubkey: "2c7cc62a697ea3a7826521f3fd34f0cb273693cbe5e9310f35449f43622a5cdc",
      relayUrls: [],
    });
  });
});

describe("decodeNaddr", () => {
  it("naddr から address と relay hint を読める", () => {
    expect(
      decodeNaddr(
        "naddr1qqyrzwrxvc6ngvfkqyghwumn8ghj7enfv96x5ctx9e3k7mgzyqalp33lewf5vdq847t6te0wvnags0gs0mu72kz8938tn24wlfze6qcyqqq823cph95ag",
      ),
    ).toEqual({
      identifier: "18ff5416",
      kind: 30023,
      pubkey: "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d",
      relayUrls: ["wss://fiatjaf.com"],
    });
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
