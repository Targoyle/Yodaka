import { describe, expect, it } from "vitest";
import { encodeNevent } from "./nip19";
import {
  buildFocusedEventHref,
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

describe("buildFocusedEventHref", () => {
  it("base path に nevent を追加する", () => {
    expect(
      buildFocusedEventHref(
        "nevent1qqsqmjvzgayw2xfr4dcwlswu9zq45rjanpjqpk0qtar05aheda89ssgxykq0y",
        {
          pathname: "/nostr/",
          search: "?foo=1",
          hash: "#bar",
        },
      ),
    ).toBe(
      "/nostr/nevent1qqsqmjvzgayw2xfr4dcwlswu9zq45rjanpjqpk0qtar05aheda89ssgxykq0y?foo=1#bar",
    );
  });

  it("既存 focused event を置き換える", () => {
    const previousNevent = encodeNevent(
      "dbe57554549f92c08bea790b05dc37dec6f3373303123f9e231635ee594ceb6a",
    );

    expect(previousNevent).not.toBeNull();
    expect(
      buildFocusedEventHref(
        "nevent1qqsqmjvzgayw2xfr4dcwlswu9zq45rjanpjqpk0qtar05aheda89ssgxykq0y",
        {
          pathname: `/nostr/${previousNevent}`,
          search: "",
          hash: "",
        },
      ),
    ).toBe(
      "/nostr/nevent1qqsqmjvzgayw2xfr4dcwlswu9zq45rjanpjqpk0qtar05aheda89ssgxykq0y",
    );
  });
});
