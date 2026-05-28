import { formatPubkey } from "../nostr/profilePresentation";
import type { SignerKind } from "../nostr/signer";
import { shortenBech32 } from "./formatters";

export function buildSignerIndicator(
  activeSignerKind: SignerKind | null,
  signerAvailable: boolean,
  signerPubkey: string | null,
  manualPubkey: string | null,
  isResolvingSignerPubkey: boolean,
) {
  if (activeSignerKind === "local" && signerPubkey) {
    return {
      tone: "ready" as const,
      label: "🔑 nsec",
      title: `${shortenBech32(formatPubkey(signerPubkey))} / タップしてログイン方法を変更`,
      action: "dialog" as const,
    };
  }

  if (isResolvingSignerPubkey) {
    return {
      tone: "pending" as const,
      label: "🟡 NIP-07",
      title: "拡張機能から公開鍵を取得中",
      action: "none" as const,
    };
  }

  if (signerPubkey) {
    return {
      tone: "ready" as const,
      label: "🟢 NIP-07",
      title: `${shortenBech32(formatPubkey(signerPubkey))} / タップしてログイン方法を変更`,
      action: "dialog" as const,
    };
  }

  if (manualPubkey) {
    return {
      tone: "ready" as const,
      label: "🔒 npub",
      title: `${shortenBech32(formatPubkey(manualPubkey))} / タップしてログイン方法を変更`,
      action: "dialog" as const,
    };
  }

  if (signerAvailable) {
    return {
      tone: "pending" as const,
      label: "🟡 NIP-07",
      title: "タップしてログイン方法を選択",
      action: "dialog" as const,
    };
  }

  return {
    tone: "missing" as const,
    label: "🔴 NIP-07",
    title: "タップしてログイン方法を選択",
    action: "dialog" as const,
  };
}
