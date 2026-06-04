import { describe, expect, it } from "vitest";

import { encodeNpub } from "./nip19";
import { extractProfileLookupPubkeysFromEvent } from "./profileLookup";

const SAMPLE_NPROFILE =
  "nprofile1qqszclxx9f5haga8sfjjrulaxncvkfekj097t6f3pu65f86rvg49ehqj6f9dh";

describe("extractProfileLookupPubkeysFromEvent", () => {
  it("author, p/e/a tag, npub/nprofile mention をまとめて抽出する", () => {
    const author = "a".repeat(64);
    const pTagged = "b".repeat(64);
    const eTaggedAuthor = "c".repeat(64);
    const aTaggedAuthor = "d".repeat(64);
    const mentioned = "e".repeat(64);
    const mentionedNpub = encodeNpub(mentioned);

    expect(mentionedNpub).not.toBeNull();

    const pubkeys = extractProfileLookupPubkeysFromEvent({
      id: "f".repeat(64),
      pubkey: author,
      created_at: 1,
      kind: 1,
      tags: [
        ["p", pTagged],
        ["e", "1".repeat(64), "", "reply", eTaggedAuthor],
        ["a", `30023:${aTaggedAuthor}:identifier`],
      ],
      content: `nostr:${mentionedNpub} nostr:${SAMPLE_NPROFILE}`,
      sig: "9".repeat(128),
    });

    expect(pubkeys).toEqual([
      author,
      pTagged,
      eTaggedAuthor,
      aTaggedAuthor,
      mentioned,
      "2c7cc62a697ea3a7826521f3fd34f0cb273693cbe5e9310f35449f43622a5cdc",
    ]);
  });

  it("不正な pubkey は無視して重複を除外する", () => {
    const author = "a".repeat(64);

    const pubkeys = extractProfileLookupPubkeysFromEvent({
      id: "f".repeat(64),
      pubkey: author,
      created_at: 1,
      kind: 1,
      tags: [
        ["p", author.toUpperCase()],
        ["p", "not-a-pubkey"],
        ["e", "1".repeat(64), "", "reply", "also-not-a-pubkey"],
      ],
      content: "npub1invalid",
      sig: "9".repeat(128),
    });

    expect(pubkeys).toEqual([author]);
  });
});
