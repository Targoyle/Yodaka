import { describe, expect, it } from "vitest";
import {
  buildEventLookupRelayUrls,
  extractReadRelayUrlsFromRelayListEvent,
} from "./eventDebug";

describe("buildEventLookupRelayUrls", () => {
  it("managed relay は全部残し、追加 hint relay は件数を絞る", () => {
    expect(
      buildEventLookupRelayUrls(
        [
          "wss://read-a.example",
          "wss://read-b.example/",
        ],
        [
          "wss://read-a.example/",
          "wss://hint-a.example",
          "wss://hint-b.example/",
          "wss://hint-c.example",
          "wss://hint-d.example",
          "wss://hint-e.example",
        ],
      ),
    ).toEqual([
      "wss://read-a.example/",
      "wss://read-b.example/",
      "wss://hint-a.example/",
      "wss://hint-b.example/",
      "wss://hint-c.example/",
      "wss://hint-d.example/",
    ]);
  });
});

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
