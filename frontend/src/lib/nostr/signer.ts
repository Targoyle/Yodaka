import { normalizeHexPubkey } from "./pubkey";
import {
  localSignerPubkey,
  presignUnsignedEvent,
  signUnsignedEventWithLocalSigner,
} from "../wasm/client";

export type UnsignedNostrEvent = {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
};

export type PresignedNostrEvent = UnsignedNostrEvent & {
  id: string;
};

export type SignedNostrEvent = UnsignedNostrEvent & {
  id: string;
  sig: string;
};

export type SignerKind = "nip07" | "local";

export interface NostrSigner {
  getPublicKey(): Promise<string>;
  signEvent(event: UnsignedNostrEvent): Promise<SignedNostrEvent>;
}

export class UnsupportedSignerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedSignerError";
  }
}

export class Nip07Signer implements NostrSigner {
  async getPublicKey(): Promise<string> {
    if (!window.nostr) {
      throw new UnsupportedSignerError("NIP-07 provider が見つかりません");
    }

    return normalizeHexPubkey(await window.nostr.getPublicKey());
  }

  async signEvent(event: UnsignedNostrEvent): Promise<SignedNostrEvent> {
    if (!window.nostr) {
      throw new UnsupportedSignerError("NIP-07 provider が見つかりません");
    }

    const presigned = await presignUnsignedEvent({
      pubkey: event.pubkey,
      createdAt: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
    });

    return window.nostr.signEvent({
      id: presigned.id,
      pubkey: presigned.pubkey,
      created_at: presigned.createdAt,
      kind: presigned.kind,
      tags: presigned.tags,
      content: presigned.content,
    });
  }
}

export class WasmLocalSigner implements NostrSigner {
  async getPublicKey(): Promise<string> {
    const pubkey = await localSignerPubkey();

    if (!pubkey) {
      throw new Error("local signer session が見つかりません");
    }

    return normalizeHexPubkey(pubkey);
  }

  async signEvent(event: UnsignedNostrEvent): Promise<SignedNostrEvent> {
    const signed = await signUnsignedEventWithLocalSigner({
      pubkey: event.pubkey,
      createdAt: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
    });

    return {
      id: signed.id,
      pubkey: signed.pubkey,
      created_at: signed.createdAt,
      kind: signed.kind,
      tags: signed.tags,
      content: signed.content,
      sig: signed.sig,
    };
  }
}

export class InMemorySigner implements NostrSigner {
  private readonly pubkey: string;

  constructor(pubkey = "phase0-test-pubkey") {
    this.pubkey = pubkey;
  }

  async getPublicKey(): Promise<string> {
    return normalizeHexPubkey(this.pubkey);
  }

  async signEvent(event: UnsignedNostrEvent): Promise<SignedNostrEvent> {
    return {
      ...event,
      id: crypto.randomUUID().replaceAll("-", ""),
      sig: "phase0-in-memory-signature",
    };
  }
}
