import { describe, expect, it } from "vitest";
import { encodeNevent, encodeNote, encodeNpub } from "./nip19";
import {
  extractContentAddressReferences,
  extractContentEventReferences,
  extractContentProfileReferences,
  normalizeContentNostrUris,
  parseContentReferenceToken,
} from "./contentReferences";

const SAMPLE_EVENT_ID =
  "dbe57554549f92c08bea790b05dc37dec6f3373303123f9e231635ee594ceb6a";
const SAMPLE_NOTE = encodeNote(SAMPLE_EVENT_ID) ?? "";
const SAMPLE_NEVENT = encodeNevent(SAMPLE_EVENT_ID) ?? "";
const SAMPLE_PUBKEY = "aa4fc8665f5696e33db7e1a572e3b0f5b3d615837b0f362dcb1c8068b098c7b4";
const SAMPLE_NPUB = encodeNpub(SAMPLE_PUBKEY) ?? "";
const SAMPLE_NPROFILE =
  "nprofile1qqszclxx9f5haga8sfjjrulaxncvkfekj097t6f3pu65f86rvg49ehqj6f9dh";
const SAMPLE_NADDR =
  "naddr1qqyrzwrxvc6ngvfkqyghwumn8ghj7enfv96x5ctx9e3k7mgzyqalp33lewf5vdq847t6te0wvnags0gs0mu72kz8938tn24wlfze6qcyqqq823cph95ag";

describe("normalizeContentNostrUris", () => {
  it("raw bech32 参照を nostr: URI へ正規化する", () => {
    expect(
      normalizeContentNostrUris(`hi ${SAMPLE_NPUB} ${SAMPLE_NOTE} ${SAMPLE_NEVENT}`),
    ).toBe(`hi nostr:${SAMPLE_NPUB} nostr:${SAMPLE_NOTE} nostr:${SAMPLE_NEVENT}`);
  });

  it("既に nostr: 付きの参照は二重 prefix しない", () => {
    expect(
      normalizeContentNostrUris(`nostr:${SAMPLE_NPUB}`),
    ).toBe(`nostr:${SAMPLE_NPUB}`);
  });
});

describe("parseContentReferenceToken", () => {
  it("nprofile を profile 参照として読める", () => {
    expect(parseContentReferenceToken(`nostr:${SAMPLE_NPROFILE}`)).toEqual({
      type: "profile",
      identifier: SAMPLE_NPROFILE,
      displayText: "npub1937vv2nf06360qn9y8el6d8sevnndy7tuh5nzre4gj05xc32tnwqauhaj6",
      pubkey: "2c7cc62a697ea3a7826521f3fd34f0cb273693cbe5e9310f35449f43622a5cdc",
      relayUrls: [],
    });
  });

  it("naddr を address 参照として読める", () => {
    expect(parseContentReferenceToken(`nostr:${SAMPLE_NADDR}`)).toEqual({
      type: "address",
      identifier: SAMPLE_NADDR,
      displayText: SAMPLE_NADDR,
      address: "30023:3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d:18ff5416",
      kind: 30023,
      pubkey: "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d",
      relayUrls: ["wss://fiatjaf.com"],
    });
  });
});

describe("extractContentEventReferences", () => {
  it("note と nevent を event id 単位で集約する", () => {
    expect(
      extractContentEventReferences(
        `see nostr:${SAMPLE_NOTE} and nostr:${SAMPLE_NEVENT}`,
      ),
    ).toEqual([
      {
        type: "event",
        identifier: SAMPLE_NOTE,
        displayText: SAMPLE_NOTE,
        eventId: SAMPLE_EVENT_ID,
        relayUrls: [],
        authorPubkey: null,
      },
    ]);
  });
});

describe("extractContentProfileReferences", () => {
  it("npub と nprofile を pubkey 単位で集約する", () => {
    expect(
      extractContentProfileReferences(
        `hello ${SAMPLE_NPUB} nostr:${SAMPLE_NPROFILE}`,
      ),
    ).toEqual([
      {
        type: "profile",
        identifier: SAMPLE_NPUB,
        displayText: SAMPLE_NPUB,
        pubkey: SAMPLE_PUBKEY,
        relayUrls: [],
      },
      {
        type: "profile",
        identifier: SAMPLE_NPROFILE,
        displayText: "npub1937vv2nf06360qn9y8el6d8sevnndy7tuh5nzre4gj05xc32tnwqauhaj6",
        pubkey: "2c7cc62a697ea3a7826521f3fd34f0cb273693cbe5e9310f35449f43622a5cdc",
        relayUrls: [],
      },
    ]);
  });
});

describe("extractContentAddressReferences", () => {
  it("naddr を address 単位で抽出する", () => {
    expect(extractContentAddressReferences(`see nostr:${SAMPLE_NADDR}`)).toEqual([
      {
        type: "address",
        identifier: SAMPLE_NADDR,
        displayText: SAMPLE_NADDR,
        address: "30023:3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d:18ff5416",
        kind: 30023,
        pubkey: "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d",
        relayUrls: ["wss://fiatjaf.com"],
      },
    ]);
  });
});
