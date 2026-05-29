import { useState, type FormEvent, type KeyboardEvent, type MutableRefObject } from "react";
import { persistAcceptedEvent } from "../lib/nostr/cache";
import {
  buildReactionContent,
  buildReactionCustomEmojiTags,
  type ReactionIntent,
} from "../lib/nostr/reaction";
import type { NostrEvent } from "../lib/nostr/relay";
import {
  RelayPublishError,
  type RelayCoordinator,
  type RelayPublishResult,
} from "../lib/nostr/relayCoordinator";
import {
  UnsupportedSignerError,
  type NostrSigner,
  type SignedNostrEvent,
  type UnsignedNostrEvent,
} from "../lib/nostr/signer";
import { assertSignedEventMatchesUnsigned } from "../lib/nostr/publish";
import {
  buildUnsignedEvent,
  verifyAndInsert,
  verifySignedEvent,
  type TimelineItem,
  type UnsignedEvent,
} from "../lib/wasm/client";
import {
  formatPublishSuccessMessage,
  formatReactionSuccessMessage,
} from "../lib/ui/formatters";

type UsePublishArgs = {
  applyRelayPublishDiagnostics: (result: RelayPublishResult) => void;
  countReadyWriteRelays: () => number;
  createActiveSigner: () => NostrSigner | null;
  ensureSignerPubkey: () => Promise<string>;
  markSignerUnavailable: () => void;
  rememberLocalReactionTarget: (item: TimelineItem) => void;
  queueProfileLookupRef: MutableRefObject<(pubkey: string) => void>;
  refreshSnapshotRef: MutableRefObject<() => Promise<TimelineItem[] | null>>;
  relayCoordinatorRef: MutableRefObject<RelayCoordinator | null>;
  requestSignerPubkeyFromUserGesture: () => Promise<string | null>;
  scheduleRefreshRef: MutableRefObject<() => void>;
  selectReactionRelayHint: () => string | null;
  signerPubkey: string | null;
  writeRelayUrls: string[];
};

export function usePublish(args: UsePublishArgs) {
  const [draftContent, setDraftContent] = useState("");
  const [isPublishing, setIsPublishing] = useState(false);
  const [pendingReactionEventIds, setPendingReactionEventIds] = useState<string[]>([]);
  const [publishMessage, setPublishMessage] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);

  async function publishDraft() {
    const content = draftContent;

    if (!content.trim() || isPublishing) {
      return;
    }

    const relayCoordinator = args.relayCoordinatorRef.current;

    if (args.writeRelayUrls.length === 0) {
      setPublishError("write relay が設定されていません");
      setPublishMessage(null);
      return;
    }

    const readyWriteRelayCount = args.countReadyWriteRelays();

    if (!relayCoordinator || readyWriteRelayCount === 0) {
      setPublishError("write relay 接続がまだ準備できていません");
      setPublishMessage(null);
      return;
    }

    const signer = args.createActiveSigner();

    if (!signer) {
      setPublishError("投稿には署名可能なログインが必要です");
      setPublishMessage(null);
      return;
    }

    setIsPublishing(true);
    setPublishError(null);
    setPublishMessage("署名を要求しています");

    try {
      const pubkey = await args.ensureSignerPubkey();

      const unsigned = await buildUnsignedEvent({
        pubkey,
        content,
        kind: 1,
        tags: [],
      });
      const signerEvent = toSignerEvent(unsigned);
      const signed = await signer.signEvent(signerEvent);
      assertSignedEventMatchesUnsigned(signerEvent, signed);

      const verified = await verifySignedEvent({
        id: signed.id,
        pubkey: signed.pubkey,
        createdAt: signed.created_at,
        kind: signed.kind,
        tags: signed.tags,
        content: signed.content,
        sig: signed.sig,
      });

      if (!verified) {
        throw new Error("署名済み event の検証に失敗しました");
      }

      const relayEvent = toRelayEvent(signed);

      setPublishMessage("relay へ送信しています");
      const publishResult = await relayCoordinator.publishEvent(relayEvent);
      args.applyRelayPublishDiagnostics(publishResult);

      const inserted = await verifyAndInsert({
        id: signed.id,
        pubkey: signed.pubkey,
        createdAt: signed.created_at,
        kind: signed.kind,
        tags: signed.tags,
        content: signed.content,
        sig: signed.sig,
      });

      if (!inserted && import.meta.env.DEV) {
        console.info(
          "[publish:local_insert]",
          "投稿イベントは既に取り込み済みのため重複挿入をスキップしました",
          { eventId: signed.id },
        );
      }

      for (const relayUrl of publishResult.acceptedRelayUrls) {
        try {
          await persistAcceptedEvent({
            relayUrl,
            event: relayEvent,
          });
        } catch (cacheError) {
          if (import.meta.env.DEV) {
            console.warn("[cache:publish]", cacheError);
          }
        }
      }

      setDraftContent("");
      setPublishMessage(formatPublishSuccessMessage(publishResult));
      setPublishError(null);
      args.scheduleRefreshRef.current();
      args.queueProfileLookupRef.current(relayEvent.pubkey);
    } catch (error) {
      if (error instanceof UnsupportedSignerError) {
        args.markSignerUnavailable();
      }

      if (error instanceof RelayPublishError) {
        args.applyRelayPublishDiagnostics({
          acceptedRelayUrls: [],
          rejectedRelayUrls: error.rejectedRelayUrls,
          errors: error.errors,
        });
      }

      const message = error instanceof Error ? error.message : String(error);
      setPublishError(message);
      setPublishMessage(null);
    } finally {
      setIsPublishing(false);
    }
  }

  async function handlePublish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await publishDraft();
  }

  function handleDraftKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) {
      return;
    }

    if (event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    void publishDraft();
  }

  async function handleReaction(item: TimelineItem, reactionIntent: ReactionIntent) {
    if (isPublishing || pendingReactionEventIds.includes(item.id)) {
      return;
    }

    const relayCoordinator = args.relayCoordinatorRef.current;

    if (args.writeRelayUrls.length === 0) {
      setPublishError("write relay が設定されていません");
      setPublishMessage(null);
      return;
    }

    const readyWriteRelayCount = args.countReadyWriteRelays();

    if (!relayCoordinator || readyWriteRelayCount === 0) {
      setPublishError("write relay 接続がまだ準備できていません");
      setPublishMessage(null);
      return;
    }

    const signer = args.createActiveSigner();

    if (!signer) {
      setPublishError("リアクション送信には署名可能なログインが必要です");
      setPublishMessage(null);
      return;
    }

    setPendingReactionEventIds((current) =>
      current.includes(item.id) ? current : [...current, item.id],
    );
    setIsPublishing(true);
    setPublishError(null);
    setPublishMessage("リアクション署名を要求しています");

    try {
      const pubkey = args.signerPubkey
        ? await args.ensureSignerPubkey()
        : await args.requestSignerPubkeyFromUserGesture();
      const reactionRelayHint = args.selectReactionRelayHint();
      const reactionContent = buildReactionContent(reactionIntent);
      const customEmojiTags = buildReactionCustomEmojiTags(reactionIntent);

      if (!pubkey) {
        throw new Error("署名ログインから公開鍵を取得できませんでした");
      }

      const unsigned = await buildUnsignedEvent({
        pubkey,
        content: reactionContent,
        kind: 7,
        tags: [
          reactionRelayHint
            ? ["e", item.id, reactionRelayHint, item.pubkey]
            : ["e", item.id],
          reactionRelayHint
            ? ["p", item.pubkey, reactionRelayHint]
            : ["p", item.pubkey],
          ["k", `${item.kind}`],
          ...customEmojiTags,
        ],
      });
      const signerEvent = toSignerEvent(unsigned);
      const signed = await signer.signEvent(signerEvent);
      assertSignedEventMatchesUnsigned(signerEvent, signed);

      const verified = await verifySignedEvent({
        id: signed.id,
        pubkey: signed.pubkey,
        createdAt: signed.created_at,
        kind: signed.kind,
        tags: signed.tags,
        content: signed.content,
        sig: signed.sig,
      });

      if (!verified) {
        throw new Error("署名済み reaction event の検証に失敗しました");
      }

      const relayEvent = toRelayEvent(signed);

      setPublishMessage("リアクションを relay へ送信しています");
      const publishResult = await relayCoordinator.publishEvent(relayEvent);
      args.applyRelayPublishDiagnostics(publishResult);

      const inserted = await verifyAndInsert({
        id: signed.id,
        pubkey: signed.pubkey,
        createdAt: signed.created_at,
        kind: signed.kind,
        tags: signed.tags,
        content: signed.content,
        sig: signed.sig,
      });

      if (!inserted && import.meta.env.DEV) {
        console.info(
          "[publish:local_insert]",
          "リアクションイベントは既に取り込み済みのため重複挿入をスキップしました",
          { eventId: signed.id },
        );
      }

      if (inserted) {
        await args.refreshSnapshotRef.current();
      } else {
        args.scheduleRefreshRef.current();
      }

      for (const relayUrl of publishResult.acceptedRelayUrls) {
        try {
          await persistAcceptedEvent({
            relayUrl,
            event: relayEvent,
          });
        } catch (cacheError) {
          if (import.meta.env.DEV) {
            console.warn("[cache:reaction]", cacheError);
          }
        }
      }

      args.rememberLocalReactionTarget(item);
      setPublishMessage(formatReactionSuccessMessage(publishResult));
      setPublishError(null);
    } catch (error) {
      if (error instanceof UnsupportedSignerError) {
        args.markSignerUnavailable();
      }

      if (error instanceof RelayPublishError) {
        args.applyRelayPublishDiagnostics({
          acceptedRelayUrls: [],
          rejectedRelayUrls: error.rejectedRelayUrls,
          errors: error.errors,
        });
      }

      const message = error instanceof Error ? error.message : String(error);
      setPublishError(message);
      setPublishMessage(null);
    } finally {
      setPendingReactionEventIds((current) =>
        current.filter((eventId) => eventId !== item.id),
      );
      setIsPublishing(false);
    }
  }

  function handleDraftContentChange(value: string) {
    setDraftContent(value);

    if (publishError) {
      setPublishError(null);
    }
  }

  function clearPublishFeedback() {
    setPublishError(null);
    setPublishMessage(null);
  }

  return {
    clearPublishFeedback,
    draftContent,
    handleDraftContentChange,
    handleDraftKeyDown,
    handlePublish,
    handleReaction,
    isPublishing,
    pendingReactionEventIds,
    publishError,
    publishMessage,
  };
}

function toSignerEvent(event: UnsignedEvent): UnsignedNostrEvent {
  return {
    pubkey: event.pubkey,
    created_at: event.createdAt,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
  };
}

function toRelayEvent(event: SignedNostrEvent): NostrEvent {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  };
}
