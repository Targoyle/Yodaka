import { describe, expect, it } from "vitest";
import { encodeNevent, encodeNote } from "../nostr/nip19";
import {
  extractContentEventReferences,
  extractContentProfileReferences,
  parseContentSegments,
} from "./contentSegments";

const SAMPLE_EVENT_ID =
  "dbe57554549f92c08bea790b05dc37dec6f3373303123f9e231635ee594ceb6a";
const SAMPLE_NOTE = encodeNote(SAMPLE_EVENT_ID) ?? "";
const SAMPLE_NEVENT = encodeNevent(SAMPLE_EVENT_ID) ?? "";
const SAMPLE_NPUB = "npub14f8usejl26twx0dhuxjh9cas7keav9vr0v8nvtwtrjqx3vycc76qqh9nsy";
const SAMPLE_NPROFILE =
  "nprofile1qqszclxx9f5haga8sfjjrulaxncvkfekj097t6f3pu65f86rvg49ehqj6f9dh";

describe("parseContentSegments", () => {
  it("plain text をそのまま返す", () => {
    expect(parseContentSegments("hello world")).toEqual([
      {
        type: "text",
        text: "hello world",
      },
    ]);
  });

  it("http url を linkify し末尾句読点を外す", () => {
    expect(parseContentSegments("see https://example.com/path?q=1。 next")).toEqual([
      {
        type: "text",
        text: "see ",
      },
      {
        type: "url",
        text: "https://example.com/path?q=1",
        href: "https://example.com/path?q=1",
      },
      {
        type: "text",
        text: "。 next",
      },
    ]);
  });

  it("nostr:nevent を内部 event link として扱う", () => {
    expect(parseContentSegments(`nostr:${SAMPLE_NEVENT}`)).toEqual([
      {
        type: "event",
        text: SAMPLE_NEVENT,
        identifier: SAMPLE_NEVENT,
        eventId: SAMPLE_EVENT_ID,
        relayUrls: [],
        authorPubkey: null,
      },
    ]);
  });

  it("nostr:note も event 参照として扱う", () => {
    expect(parseContentSegments(`nostr:${SAMPLE_NOTE}`)).toEqual([
      {
        type: "event",
        text: SAMPLE_NOTE,
        identifier: SAMPLE_NOTE,
        eventId: SAMPLE_EVENT_ID,
        relayUrls: [],
        authorPubkey: null,
      },
    ]);
  });

  it("raw npub mention を抽出する", () => {
    expect(parseContentSegments(`hello ${SAMPLE_NPUB}`)).toEqual([
      {
        type: "text",
        text: "hello ",
      },
      {
        type: "mention",
        text: SAMPLE_NPUB,
        identifier: SAMPLE_NPUB,
        pubkey: "aa4fc8665f5696e33db7e1a572e3b0f5b3d615837b0f362dcb1c8068b098c7b4",
        relayUrls: [],
      },
    ]);
  });

  it("nostr:nprofile を mention として扱う", () => {
    expect(parseContentSegments(`nostr:${SAMPLE_NPROFILE}`)).toEqual([
      {
        type: "mention",
        text: "npub1937vv2nf06360qn9y8el6d8sevnndy7tuh5nzre4gj05xc32tnwqauhaj6",
        identifier: SAMPLE_NPROFILE,
        pubkey: "2c7cc62a697ea3a7826521f3fd34f0cb273693cbe5e9310f35449f43622a5cdc",
        relayUrls: [],
      },
    ]);
  });

  it("不正な raw npub は linkify しない", () => {
    expect(parseContentSegments("npub1invalid")).toEqual([
      {
        type: "text",
        text: "npub1invalid",
      },
    ]);
  });

  it("本文内 nevent 参照を event id 単位で集約できる", () => {
    expect(
      extractContentEventReferences(
        `see nostr:${SAMPLE_NEVENT} and again nostr:${SAMPLE_NEVENT}`,
      ),
    ).toEqual([
      {
        type: "event",
        identifier: SAMPLE_NEVENT,
        displayText: SAMPLE_NEVENT,
        eventId: SAMPLE_EVENT_ID,
        relayUrls: [],
        authorPubkey: null,
      },
    ]);
  });

  it("本文内 profile 参照を pubkey 単位で集約できる", () => {
    expect(
      extractContentProfileReferences(
        `hello ${SAMPLE_NPUB} nostr:${SAMPLE_NPROFILE}`,
      ),
    ).toEqual([
      {
        type: "profile",
        identifier: SAMPLE_NPUB,
        displayText: SAMPLE_NPUB,
        pubkey: "aa4fc8665f5696e33db7e1a572e3b0f5b3d615837b0f362dcb1c8068b098c7b4",
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
