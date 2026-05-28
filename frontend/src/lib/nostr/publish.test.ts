import { describe, expect, it } from "vitest";

import { assertSignedEventMatchesUnsigned } from "./publish";

describe("assertSignedEventMatchesUnsigned", () => {
  it("要求した内容と一致する署名済み event を受け入れる", () => {
    expect(() =>
      assertSignedEventMatchesUnsigned(
        {
          pubkey:
            "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          created_at: 1_717_777_777,
          kind: 1,
          tags: [["t", "nostr"]],
          content: "hello",
        },
        {
          id: "event-id",
          sig: "event-sig",
          pubkey:
            "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
          created_at: 1_717_777_777,
          kind: 1,
          tags: [["t", "nostr"]],
          content: "hello",
        },
      ),
    ).not.toThrow();
  });

  it("provider が content を差し替えた場合は拒否する", () => {
    expect(() =>
      assertSignedEventMatchesUnsigned(
        {
          pubkey:
            "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          created_at: 1_717_777_777,
          kind: 1,
          tags: [],
          content: "expected",
        },
        {
          id: "event-id",
          sig: "event-sig",
          pubkey:
            "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          created_at: 1_717_777_777,
          kind: 1,
          tags: [],
          content: "unexpected",
        },
      ),
    ).toThrow("content");
  });

  it("provider が tags を差し替えた場合は拒否する", () => {
    expect(() =>
      assertSignedEventMatchesUnsigned(
        {
          pubkey:
            "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          created_at: 1_717_777_777,
          kind: 1,
          tags: [["t", "expected"]],
          content: "hello",
        },
        {
          id: "event-id",
          sig: "event-sig",
          pubkey:
            "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          created_at: 1_717_777_777,
          kind: 1,
          tags: [["t", "unexpected"]],
          content: "hello",
        },
      ),
    ).toThrow("tags");
  });
});
