import { describe, expect, it } from "vitest";

import { normalizeRelayUrl } from "./relayUrl";

describe("normalizeRelayUrl", () => {
  it("remote relay は wss だけを許可する", () => {
    expect(normalizeRelayUrl("wss://yabu.me")).toBe("wss://yabu.me/");
    expect(normalizeRelayUrl("ws://yabu.me")).toBeNull();
  });

  it("localhost 系の開発 relay だけ ws を許可する", () => {
    expect(normalizeRelayUrl("ws://localhost:7000")).toBe("ws://localhost:7000/");
    expect(normalizeRelayUrl("ws://127.0.0.1:7000")).toBe(
      "ws://127.0.0.1:7000/",
    );
    expect(normalizeRelayUrl("ws://[::1]:7000")).toBe("ws://[::1]:7000/");
    expect(normalizeRelayUrl("ws://app.localhost:7000")).toBe(
      "ws://app.localhost:7000/",
    );
    expect(normalizeRelayUrl("ws://192.168.0.10:7000")).toBeNull();
  });
});
