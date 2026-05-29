import { describe, expect, it } from "vitest";
import { extractReadRelayUrlsFromRelayListEvent } from "./eventDebug";

describe("extractReadRelayUrlsFromRelayListEvent", () => {
  it("returns read relays and excludes write-only relays", () => {
    expect(
      extractReadRelayUrlsFromRelayListEvent({
        id: "relay-list",
        pubkey: "author",
        created_at: 1,
        kind: 10002,
        tags: [
          ["r", "wss://read.example"],
          ["r", "wss://both.example", "read"],
          ["r", "wss://write.example", "write"],
        ],
        content: "",
        sig: "sig",
      }),
    ).toEqual(["wss://read.example/", "wss://both.example/"]);
  });

  it("ignores non-relay-list events", () => {
    expect(
      extractReadRelayUrlsFromRelayListEvent({
        id: "note",
        pubkey: "author",
        created_at: 1,
        kind: 1,
        tags: [["r", "wss://read.example"]],
        content: "hello",
        sig: "sig",
      }),
    ).toEqual([]);
  });
});
