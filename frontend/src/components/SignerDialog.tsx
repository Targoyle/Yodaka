import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { decodeNsec } from "../lib/nostr/nip19";

type SignerDialogProps = {
  canClearCurrentSigner: boolean;
  isNip07Available: boolean;
  isLocalSignerActive: boolean;
  isOpen: boolean;
  isResolvingSignerPubkey: boolean;
  onClose: () => void;
  onClearCurrentSigner: () => Promise<void>;
  onOpenManualPubkey: () => Promise<void>;
  onUseExtension: () => Promise<string | null>;
  onUseNsec: (nsec: string) => Promise<string | null>;
};

export function SignerDialog(props: SignerDialogProps) {
  const [nsecDraft, setNsecDraft] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isSubmittingNsec, setIsSubmittingNsec] = useState(false);
  const passwordInputRef = useRef<HTMLInputElement | null>(null);
  const lastSubmittedNsecRef = useRef<string | null>(null);

  useEffect(() => {
    if (!props.isOpen) {
      setNsecDraft("");
      setErrorMessage(null);
      setStatusMessage(null);
      setIsSubmittingNsec(false);
      lastSubmittedNsecRef.current = null;
      return;
    }

    const focusTimer = window.setTimeout(() => {
      if (!props.isLocalSignerActive) {
        passwordInputRef.current?.focus();
      }
    }, 0);

    return () => {
      window.clearTimeout(focusTimer);
    };
  }, [props.isLocalSignerActive, props.isOpen]);

  useEffect(() => {
    if (!props.isOpen || props.isLocalSignerActive || isSubmittingNsec) {
      return;
    }

    const trimmed = nsecDraft.trim();

    if (
      !trimmed
      || trimmed === lastSubmittedNsecRef.current
      || !looksLikeNsecInput(trimmed)
    ) {
      return;
    }

    const autoSubmitTimer = window.setTimeout(() => {
      void submitNsec(trimmed);
    }, 120);

    return () => {
      window.clearTimeout(autoSubmitTimer);
    };
  }, [isSubmittingNsec, nsecDraft, props.isLocalSignerActive, props.isOpen]);

  if (!props.isOpen) {
    return null;
  }

  function handleClose() {
    setNsecDraft("");
    setErrorMessage(null);
    setStatusMessage(null);
    setIsSubmittingNsec(false);
    lastSubmittedNsecRef.current = null;
    props.onClose();
  }

  function handleNsecDraftChange(nextValue: string) {
    if (lastSubmittedNsecRef.current && nextValue.trim() !== lastSubmittedNsecRef.current) {
      lastSubmittedNsecRef.current = null;
    }

    if (errorMessage) {
      setErrorMessage(null);
    }

    if (statusMessage) {
      setStatusMessage(null);
    }

    setNsecDraft(nextValue);
  }

  async function handleExtensionLogin() {
    if (props.isResolvingSignerPubkey || !props.isNip07Available) {
      return;
    }

    setErrorMessage(null);
    setStatusMessage("NIP-07 へ公開鍵要求を送っています");

    try {
      const pubkey = await props.onUseExtension();

      if (!pubkey) {
        throw new Error("NIP-07 から公開鍵を取得できませんでした");
      }

      handleClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(message);
      setStatusMessage(null);
    }
  }

  async function handleNsecSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nsec = nsecDraft.trim();

    if (!nsec || isSubmittingNsec) {
      return;
    }

    await submitNsec(nsec);
  }

  async function submitNsec(nsec: string) {
    lastSubmittedNsecRef.current = nsec;
    setNsecDraft("");

    setIsSubmittingNsec(true);
    setErrorMessage(null);
    setStatusMessage("nsec を検証しています");

    try {
      const pubkey = await props.onUseNsec(nsec);

      if (!pubkey) {
        throw new Error("nsec から公開鍵を取得できませんでした");
      }

      handleClose();
    } catch (error) {
      setNsecDraft(nsec);
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(message);
      setStatusMessage(null);
    } finally {
      setIsSubmittingNsec(false);
    }
  }

  async function handleOpenManualPubkey() {
    setNsecDraft("");
    setErrorMessage(null);
    setStatusMessage(null);
    setIsSubmittingNsec(false);

    try {
      await props.onOpenManualPubkey();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(message);
    }
  }

  async function handleClearCurrentSigner() {
    setErrorMessage(null);
    setStatusMessage("ログアウトしています");

    try {
      await props.onClearCurrentSigner();
      handleClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(message);
      setStatusMessage(null);
    }
  }

  return (
    <div
      className="dialog-backdrop"
      onClick={handleClose}
      role="presentation"
    >
      <section
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="signer-dialog-title"
        onClick={(dialogEvent) => dialogEvent.stopPropagation()}
      >
        <div className="signer-dialog-stack">
          <div className="signer-dialog-section">
            <div className="dialog-copy">
              <h3 className="signer-dialog-heading">NIP-07</h3>
              <p className="muted dialog-text">
                拡張機能から公開鍵取得と署名を行います。
              </p>
            </div>
            <button
              type="button"
              className="dialog-button dialog-button-secondary"
              onClick={() => {
                void handleExtensionLogin();
              }}
              disabled={!props.isNip07Available || props.isResolvingSignerPubkey}
            >
              {props.isResolvingSignerPubkey
                ? "確認中..."
                : props.isNip07Available
                  ? "NIP-07 を使う"
                  : "NIP-07 未検出"}
            </button>
          </div>

          <div className="signer-dialog-section">
            <div className="dialog-copy">
              <h3 className="signer-dialog-heading">npub</h3>
            </div>
            <button
              type="button"
              className="dialog-button dialog-button-secondary"
              onClick={() => {
                void handleOpenManualPubkey();
              }}
              disabled={props.isLocalSignerActive}
            >
              npub を入力
            </button>
          </div>

          <form className="signer-dialog-section" onSubmit={handleNsecSubmit}>
            <div className="dialog-copy">
              <h3 className="signer-dialog-heading">nsec</h3>
            </div>
            <div className="dialog-input-shell">
              <input
                ref={passwordInputRef}
                className="dialog-input"
                type="password"
                name="nostr-secret-key"
                value={nsecDraft}
                onChange={(inputEvent) => handleNsecDraftChange(inputEvent.target.value)}
                placeholder="nsec1... or hex"
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="current-password"
                spellCheck={false}
                aria-label="nsec"
                disabled={props.isLocalSignerActive || isSubmittingNsec}
              />
            </div>
            <p className="muted dialog-text">
              Yodaka は秘密鍵を保存しません。
              <br />
              パスワードマネージャを使用してください。
            </p>
          </form>

          {errorMessage ? (
            <p className="composer-feedback composer-status-error">
              {errorMessage}
            </p>
          ) : statusMessage ? (
            <p className="composer-feedback muted">
              {statusMessage}
            </p>
          ) : null}

          {props.canClearCurrentSigner ? (
            <div className="dialog-actions">
              <button
                type="button"
                className="dialog-button dialog-button-secondary"
                onClick={() => {
                  void handleClearCurrentSigner();
                }}
              >
                ログアウト
              </button>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function looksLikeNsecInput(value: string) {
  return /^[0-9a-f]{64}$/i.test(value) || decodeNsec(value) !== null;
}
