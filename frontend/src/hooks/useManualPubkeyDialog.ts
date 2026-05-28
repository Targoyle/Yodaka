import { useEffect, useRef, useState, type FormEvent } from "react";
import type { TimelineView } from "../app/types";
import {
  clearManualPubkey as clearStoredManualPubkey,
  saveManualPubkey,
} from "../lib/nostr/storage";
import { parseViewerPubkeyInput } from "../lib/nostr/viewerPubkey";

type UseManualPubkeyDialogArgs = {
  initialManualPubkey: string | null;
  signerPubkey: string | null;
  timelineView: TimelineView;
  setTimelineView: (view: TimelineView) => void;
};

export function useManualPubkeyDialog(args: UseManualPubkeyDialogArgs) {
  const [manualPubkey, setManualPubkey] = useState<string | null>(
    args.initialManualPubkey,
  );
  const [manualPubkeyDialogOpen, setManualPubkeyDialogOpen] = useState(false);
  const [manualPubkeyDraft, setManualPubkeyDraft] = useState("");
  const [manualPubkeyError, setManualPubkeyError] = useState<string | null>(null);
  const [manualPubkeyHint, setManualPubkeyHint] = useState<string | null>(null);
  const [isPastingManualPubkey, setIsPastingManualPubkey] = useState(false);
  const manualPubkeyInputRef = useRef<HTMLInputElement | null>(null);
  const manualPubkeyPasteButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!manualPubkeyDialogOpen) {
      return;
    }

    const focusTimer = window.setTimeout(() => {
      manualPubkeyPasteButtonRef.current?.focus();
    }, 0);

    return () => {
      window.clearTimeout(focusTimer);
    };
  }, [manualPubkeyDialogOpen]);

  useEffect(() => {
    if (!manualPubkeyDialogOpen || typeof document === "undefined") {
      return;
    }

    function handleDocumentPointerDown(event: PointerEvent) {
      const input = manualPubkeyInputRef.current;

      if (!input || document.activeElement !== input) {
        return;
      }

      if (event.target === input) {
        return;
      }

      input.blur();
    }

    document.addEventListener("pointerdown", handleDocumentPointerDown, true);

    return () => {
      document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
    };
  }, [manualPubkeyDialogOpen]);

  function openManualPubkeyDialog(viewerPubkey: string | null) {
    setManualPubkeyDraft(viewerPubkey ?? "");
    setManualPubkeyError(null);
    setManualPubkeyHint(null);
    setManualPubkeyDialogOpen(true);
  }

  function closeManualPubkeyDialog() {
    setManualPubkeyDialogOpen(false);
    setManualPubkeyError(null);
    setManualPubkeyHint(null);
    setIsPastingManualPubkey(false);
  }

  function handleManualPubkeyClear() {
    clearStoredManualPubkey();
    setManualPubkey(null);
    setManualPubkeyDraft("");
    setManualPubkeyError(null);
    setManualPubkeyHint(null);
    setIsPastingManualPubkey(false);
    setManualPubkeyDialogOpen(false);

    if (!args.signerPubkey && args.timelineView !== "relay") {
      args.setTimelineView("relay");
    }
  }

  function rememberManualPubkey(pubkey: string) {
    saveManualPubkey(pubkey);
    setManualPubkey(pubkey);
    setManualPubkeyError(null);
    setManualPubkeyHint(null);
  }

  function handleManualPubkeyDraftChange(value: string) {
    setManualPubkeyDraft(value);

    if (manualPubkeyError) {
      setManualPubkeyError(null);
    }

    if (manualPubkeyHint) {
      setManualPubkeyHint(null);
    }
  }

  function handleManualPubkeySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const normalizedPubkey = parseViewerPubkeyInput(manualPubkeyDraft);

    if (!normalizedPubkey) {
      setManualPubkeyError("npub または 64 桁 hex 公開鍵を入力してください");
      setManualPubkeyHint(null);
      return;
    }

    saveManualPubkey(normalizedPubkey);
    setManualPubkey(normalizedPubkey);
    setManualPubkeyError(null);
    setManualPubkeyHint(null);
    setManualPubkeyDialogOpen(false);
  }

  function focusManualPubkeyInput() {
    manualPubkeyInputRef.current?.focus();
  }

  async function handleManualPubkeyPaste() {
    if (isPastingManualPubkey) {
      return;
    }

    if (
      typeof navigator === "undefined"
      || typeof navigator.clipboard?.readText !== "function"
    ) {
      focusManualPubkeyInput();
      setManualPubkeyError(null);
      setManualPubkeyHint("入力欄をタップして OS の貼り付けを使ってください");
      return;
    }

    setIsPastingManualPubkey(true);
    setManualPubkeyError(null);
    setManualPubkeyHint(null);

    try {
      const clipboardText = (await navigator.clipboard.readText()).trim();

      if (!clipboardText) {
        setManualPubkeyError("クリップボードが空です");
        setManualPubkeyHint(null);
        return;
      }

      setManualPubkeyDraft(clipboardText);
      setManualPubkeyHint(null);
    } catch (error) {
      const errorName = typeof error === "object" && error && "name" in error
        ? String(error.name)
        : "";

      if (errorName === "NotAllowedError") {
        focusManualPubkeyInput();
        setManualPubkeyError(null);
        setManualPubkeyHint("入力欄をタップして OS の貼り付けを使ってください");
        return;
      }

      setManualPubkeyError("クリップボードを読み取れませんでした");
      setManualPubkeyHint(null);
    } finally {
      setIsPastingManualPubkey(false);
    }
  }

  return {
    closeManualPubkeyDialog,
    handleManualPubkeyClear,
    handleManualPubkeyDraftChange,
    handleManualPubkeyPaste,
    handleManualPubkeySubmit,
    isPastingManualPubkey,
    manualPubkey,
    manualPubkeyDialogOpen,
    manualPubkeyDraft,
    manualPubkeyError,
    manualPubkeyHint,
    manualPubkeyInputRef,
    manualPubkeyPasteButtonRef,
    openManualPubkeyDialog,
    rememberManualPubkey,
  };
}
