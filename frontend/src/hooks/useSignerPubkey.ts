import { useEffect, useRef, useState } from "react";
import { normalizeHexPubkey } from "../lib/nostr/pubkey";
import {
  Nip07Signer,
  UnsupportedSignerError,
  WasmLocalSigner,
  type NostrSigner,
  type SignerKind,
} from "../lib/nostr/signer";
import { parseViewerPubkeyInput } from "../lib/nostr/viewerPubkey";
import {
  hasLocalSigner,
  localSignerPubkey,
  logoutLocalSigner,
} from "../lib/wasm/client";

export function useSignerPubkey() {
  const [signerAvailable, setSignerAvailable] = useState(false);
  const [signerPubkey, setSignerPubkey] = useState<string | null>(null);
  const [activeSignerKind, setActiveSignerKind] = useState<SignerKind | null>(null);
  const [isResolvingSignerPubkey, setIsResolvingSignerPubkey] = useState(false);
  const [autoSignerPromptBlocked, setAutoSignerPromptBlocked] = useState(false);
  const [signerRequestError, setSignerRequestError] = useState<string | null>(null);
  const [signerRequestMessage, setSignerRequestMessage] = useState<string | null>(null);
  const activeSignerKindRef = useRef<SignerKind | null>(null);

  useEffect(() => {
    activeSignerKindRef.current = activeSignerKind;
  }, [activeSignerKind]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 20;
    const intervalId = setInterval(() => {
      attempts += 1;
      const available = Boolean(window.nostr);

      if (!cancelled) {
        setSignerAvailable(available);
      }

      if (available || attempts >= maxAttempts) {
        clearInterval(intervalId);
      }
    }, 250);

    setSignerAvailable(Boolean(window.nostr));
    void refreshLocalSignerSession().catch((error) => {
      if (import.meta.env.DEV) {
        console.warn("[signer:local_restore]", error);
      }
    });

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  async function refreshLocalSignerSession() {
    const hasSession = await hasLocalSigner();

    if (!hasSession) {
      if (activeSignerKindRef.current === "local") {
        setActiveSignerKind(null);
        setSignerPubkey(null);
      }

      return null;
    }

    const rawPubkey = await localSignerPubkey();

    if (!rawPubkey) {
      throw new Error("local signer が公開鍵を返しませんでした");
    }

    const pubkey = parseViewerPubkeyInput(rawPubkey);

    if (!pubkey) {
      throw new Error("local signer が不正な公開鍵を返しました");
    }

    setSignerPubkey(pubkey);
    setActiveSignerKind("local");
    setAutoSignerPromptBlocked(false);
    setSignerRequestError(null);
    setSignerRequestMessage(null);

    return pubkey;
  }

  async function clearLocalSignerSession() {
    if (await hasLocalSigner()) {
      await logoutLocalSigner();
    }
  }

  async function ensureSignerPubkey(options?: {
    forceRefresh?: boolean;
    target?: "active" | "nip07";
  }) {
    const forceRefresh = options?.forceRefresh ?? false;
    const target = options?.target ?? "active";

    if (target !== "nip07" && activeSignerKind === "local") {
      const pubkey = await refreshLocalSignerSession();

      if (!pubkey) {
        throw new Error("local signer session が見つかりません");
      }

      return normalizeHexPubkey(pubkey);
    }

    if (signerPubkey && !forceRefresh && (target !== "nip07" || activeSignerKind === "nip07")) {
      return normalizeHexPubkey(signerPubkey);
    }

    const signer = new Nip07Signer();
    const pubkey = parseViewerPubkeyInput(await signer.getPublicKey());

    if (!pubkey) {
      throw new Error("NIP-07 provider が不正な公開鍵を返しました");
    }

    setSignerAvailable(true);
    setSignerPubkey(pubkey);
    setActiveSignerKind("nip07");

    return pubkey;
  }

  async function ensureViewerPubkey(manualPubkey: string | null) {
    if (signerPubkey) {
      return normalizeHexPubkey(signerPubkey);
    }

    if (manualPubkey) {
      return normalizeHexPubkey(manualPubkey);
    }

    return ensureSignerPubkey();
  }

  async function requestSignerPubkeyFromUserGesture(options?: {
    forceRefresh?: boolean;
  }) {
    const forceRefresh = options?.forceRefresh ?? false;

    if (activeSignerKind === "local") {
      return refreshLocalSignerSession();
    }

    if (isResolvingSignerPubkey) {
      return signerPubkey;
    }

    if (signerPubkey && !forceRefresh) {
      return signerPubkey;
    }

    if (!signerAvailable) {
      return null;
    }

    setIsResolvingSignerPubkey(true);
    setAutoSignerPromptBlocked(false);
    setSignerRequestError(null);
    setSignerRequestMessage(
      forceRefresh
        ? "拡張機能から公開鍵を再確認しています"
        : "拡張機能から公開鍵を取得しています",
    );

    try {
      const pubkey = await ensureSignerPubkey({
        forceRefresh,
      });
      setSignerRequestMessage(null);
      return pubkey;
    } catch (error) {
      if (error instanceof UnsupportedSignerError) {
        setSignerAvailable(false);
      } else {
        setAutoSignerPromptBlocked(true);
      }

      const message = error instanceof Error ? error.message : String(error);
      setSignerRequestError(message);
      setSignerRequestMessage(null);
      throw error;
    } finally {
      setIsResolvingSignerPubkey(false);
    }
  }

  async function requestNip07PubkeyFromUserGesture(options?: {
    forceRefresh?: boolean;
  }) {
    const forceRefresh = options?.forceRefresh ?? false;

    if (isResolvingSignerPubkey) {
      return signerPubkey;
    }

    if (activeSignerKind === "nip07" && signerPubkey && !forceRefresh) {
      return signerPubkey;
    }

    if (!signerAvailable) {
      return null;
    }

    setIsResolvingSignerPubkey(true);
    setAutoSignerPromptBlocked(false);
    setSignerRequestError(null);
    setSignerRequestMessage(
      forceRefresh
        ? "拡張機能から公開鍵を再確認しています"
        : "拡張機能から公開鍵を取得しています",
    );

    try {
      const pubkey = await ensureSignerPubkey({
        forceRefresh,
        target: "nip07",
      });
      await clearLocalSignerSession();
      setSignerRequestMessage(null);
      return pubkey;
    } catch (error) {
      if (error instanceof UnsupportedSignerError) {
        setSignerAvailable(false);
      } else {
        setAutoSignerPromptBlocked(true);
      }

      const message = error instanceof Error ? error.message : String(error);
      setSignerRequestError(message);
      setSignerRequestMessage(null);
      throw error;
    } finally {
      setIsResolvingSignerPubkey(false);
    }
  }

  function createActiveSigner(): NostrSigner | null {
    if (activeSignerKind === "local") {
      return new WasmLocalSigner();
    }

    if (typeof window !== "undefined" && window.nostr) {
      return new Nip07Signer();
    }

    return null;
  }

  function markSignerUnavailable() {
    setSignerAvailable(false);
  }

  function clearSignerRequestFeedback() {
    setSignerRequestError(null);
    setSignerRequestMessage(null);
  }

  async function adoptNip07SignerPubkey(pubkey: string) {
    const normalizedPubkey = parseViewerPubkeyInput(pubkey);

    if (!normalizedPubkey) {
      throw new Error("NIP-07 signer の公開鍵が不正です");
    }

    await clearLocalSignerSession();
    setSignerAvailable(true);
    setSignerPubkey(normalizedPubkey);
    setActiveSignerKind("nip07");
    setAutoSignerPromptBlocked(false);
    clearSignerRequestFeedback();

    return normalizedPubkey;
  }

  async function clearActiveSigner() {
    await clearLocalSignerSession();

    setActiveSignerKind(null);
    setSignerPubkey(null);
    setAutoSignerPromptBlocked(false);
    clearSignerRequestFeedback();
  }

  return {
    activeSignerKind,
    autoSignerPromptBlocked,
    clearActiveSigner,
    adoptNip07SignerPubkey,
    clearSignerRequestFeedback,
    createActiveSigner,
    ensureSignerPubkey,
    ensureViewerPubkey,
    isResolvingSignerPubkey,
    markSignerUnavailable,
    refreshLocalSignerSession,
    requestNip07PubkeyFromUserGesture,
    requestSignerPubkeyFromUserGesture,
    setAutoSignerPromptBlocked,
    signerAvailable,
    signerPubkey,
    signerRequestError,
    signerRequestMessage,
  };
}
