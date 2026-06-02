import { describe, expect, it } from "vitest";
import {
  resolveFocusedEventRouteFromLocation,
  stripFocusedEventFromLocation,
} from "./eventRoute";

describe("resolveFocusedEventRouteFromLocation", () => {
  it("末尾 nevent を focused route として解釈する", () => {
    expect(
      resolveFocusedEventRouteFromLocation({
        pathname: "/nostr/nevent1qqsqmjvzgayw2xfr4dcwlswu9zq45rjanpjqpk0qtar05aheda89ssgxykq0y",
        search: "",
      }),
    ).toEqual({
      nevent: "nevent1qqsqmjvzgayw2xfr4dcwlswu9zq45rjanpjqpk0qtar05aheda89ssgxykq0y",
      eventId: "0dc9824748e51923ab70efc1dc28815a0e5d986400d9e05f46fa76f96f4e5841",
      relayUrls: [],
      authorPubkey: null,
    });
  });

  it("通常パスは null を返す", () => {
    expect(
      resolveFocusedEventRouteFromLocation({
        pathname: "/nostr/",
        search: "",
      }),
    ).toBeNull();
  });
});

describe("stripFocusedEventFromLocation", () => {
  it("末尾 nevent を取り除いて base path を返す", () => {
    expect(
      stripFocusedEventFromLocation({
        pathname: "/nostr/nevent1qqsqmjvzgayw2xfr4dcwlswu9zq45rjanpjqpk0qtar05aheda89ssgxykq0y",
        search: "?foo=1",
        hash: "#bar",
      }),
    ).toBe("/nostr/?foo=1#bar");
  });

  it("nevent でなければそのまま返す", () => {
    expect(
      stripFocusedEventFromLocation({
        pathname: "/nostr/miner",
        search: "",
      }),
    ).toBe("/nostr/miner");
  });
});
