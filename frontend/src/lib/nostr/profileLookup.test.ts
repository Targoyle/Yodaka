import { describe, expect, it } from "vitest";

import { encodeNpub } from "./nip19";
import { extractProfileLookupPubkeysFromEvent } from "./profileLookup";

describe("extractProfileLookupPubkeysFromEvent", () => {
  it("author, p/e/a tag, npub mention をまとめて抽出する", () => {
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
      content: `nostr:${mentionedNpub}`,
      sig: "9".repeat(128),
    });

    expect(pubkeys).toEqual([
      author,
      pTagged,
      eTaggedAuthor,
      aTaggedAuthor,
      mentioned,
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
