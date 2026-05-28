/// <reference types="vite/client" />

declare module "@wasm/nostr_wasm.js" {
  export default function init(): Promise<void>;

  export function build_unsigned_event(
    pubkey: string,
    content: string,
    tagsJson: string,
    kind: number,
  ): string;

  export function verify_and_insert(eventJson: string): boolean;

  export function list_timeline(limit: number, until?: number): string;

  export function since_hint(): string;

  export function reset_timeline(): void;
}

declare module "@miner-wasm/nostr_miner_wasm.js" {
  export default function init(): Promise<void>;

  export function derive_secret_summary(secretHex: string): string;

  export function generator_window_table(): string;

  export function pubkey_hex_from_secret(secretHex: string): string;
}

declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>;
      signEvent(event: import("./lib/nostr/signer").UnsignedNostrEvent): Promise<
        import("./lib/nostr/signer").SignedNostrEvent
      >;
    };
  }
}

export {};
