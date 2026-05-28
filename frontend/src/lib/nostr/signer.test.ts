import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  localSignerPubkeyMock,
  signUnsignedEventWithLocalSignerMock,
} = vi.hoisted(() => ({
  localSignerPubkeyMock: vi.fn(),
  signUnsignedEventWithLocalSignerMock: vi.fn(),
}));

vi.mock("../wasm/client", () => ({
  localSignerPubkey: localSignerPubkeyMock,
  signUnsignedEventWithLocalSigner: signUnsignedEventWithLocalSignerMock,
}));

import { WasmLocalSigner } from "./signer";

describe("WasmLocalSigner", () => {
  beforeEach(() => {
    localSignerPubkeyMock.mockReset();
    signUnsignedEventWithLocalSignerMock.mockReset();
  });

  it("WASM 側の createdAt を NIP-07 互換の created_at へ変換する", async () => {
    signUnsignedEventWithLocalSignerMock.mockResolvedValue({
      id: "event-id",
      pubkey:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      createdAt: 1_717_777_777,
      kind: 1,
      tags: [["t", "nostr"]],
      content: "hello",
      sig: "event-sig",
    });

    const signer = new WasmLocalSigner();
    const signed = await signer.signEvent({
      pubkey:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      created_at: 1_717_777_777,
      kind: 1,
      tags: [["t", "nostr"]],
      content: "hello",
    });

    expect(signed.created_at).toBe(1_717_777_777);
    expect(signed.content).toBe("hello");
  });
});
