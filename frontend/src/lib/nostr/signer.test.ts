import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  presignUnsignedEventMock,
  localSignerPubkeyMock,
  signUnsignedEventWithLocalSignerMock,
} = vi.hoisted(() => ({
  presignUnsignedEventMock: vi.fn(),
  localSignerPubkeyMock: vi.fn(),
  signUnsignedEventWithLocalSignerMock: vi.fn(),
}));

vi.mock("../wasm/client", () => ({
  localSignerPubkey: localSignerPubkeyMock,
  presignUnsignedEvent: presignUnsignedEventMock,
  signUnsignedEventWithLocalSigner: signUnsignedEventWithLocalSignerMock,
}));

import { Nip07Signer, WasmLocalSigner } from "./signer";

describe("signer", () => {
  beforeEach(() => {
    localSignerPubkeyMock.mockReset();
    presignUnsignedEventMock.mockReset();
    signUnsignedEventWithLocalSignerMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("NIP-07 署名時は空 content の event にも id を付けて渡す", async () => {
    const signEventMock = vi.fn().mockImplementation(async (event) => ({
      ...event,
      sig: "signed-sig",
    }));
    presignUnsignedEventMock.mockResolvedValue({
      id: "presigned-id",
      pubkey: "f".repeat(64),
      createdAt: 1_717_777_777,
      kind: 6,
      tags: [
        ["e", "event-id", "wss://relay.example/"],
        ["p", "a".repeat(64)],
      ],
      content: "",
    });
    vi.stubGlobal("window", {
      nostr: {
        getPublicKey: vi.fn(),
        signEvent: signEventMock,
      },
    });

    const signer = new Nip07Signer();
    await signer.signEvent({
      pubkey: "f".repeat(64),
      created_at: 1_717_777_777,
      kind: 6,
      tags: [
        ["e", "event-id", "wss://relay.example/"],
        ["p", "a".repeat(64)],
      ],
      content: "",
    });

    expect(signEventMock).toHaveBeenCalledTimes(1);
    expect(presignUnsignedEventMock).toHaveBeenCalledWith({
      pubkey: "f".repeat(64),
      createdAt: 1_717_777_777,
      kind: 6,
      tags: [
        ["e", "event-id", "wss://relay.example/"],
        ["p", "a".repeat(64)],
      ],
      content: "",
    });
    expect(signEventMock).toHaveBeenCalledWith({
      pubkey: "f".repeat(64),
      created_at: 1_717_777_777,
      kind: 6,
      tags: [
        ["e", "event-id", "wss://relay.example/"],
        ["p", "a".repeat(64)],
      ],
      content: "",
      id: "presigned-id",
    });
  });
});
