import type {
  FormEventHandler,
  MutableRefObject,
} from "react";

type ManualPubkeyDialogProps = {
  closeDialog: () => void;
  draftValue: string;
  errorMessage: string | null;
  hintMessage: string | null;
  inputRef: MutableRefObject<HTMLInputElement | null>;
  isOpen: boolean;
  isPasting: boolean;
  pasteButtonRef: MutableRefObject<HTMLButtonElement | null>;
  onClear: () => void;
  onDraftChange: (value: string) => void;
  onPaste: () => Promise<void>;
  onSubmit: FormEventHandler<HTMLFormElement>;
};

export function ManualPubkeyDialog(props: ManualPubkeyDialogProps) {
  if (!props.isOpen) {
    return null;
  }

  return (
    <div
      className="dialog-backdrop"
      onClick={props.closeDialog}
      role="presentation"
    >
      <section
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-pubkey-title"
        onClick={(dialogEvent) => dialogEvent.stopPropagation()}
      >
        <form className="dialog-form" onSubmit={props.onSubmit}>
          <div className="dialog-copy">
            <h2 id="manual-pubkey-title" className="dialog-title">
              公開鍵入力
            </h2>
            <p className="muted dialog-text">
              `npub1...` または 64 桁 hex を入力してください。
            </p>
          </div>
          <div className="dialog-input-shell">
            <input
              ref={props.inputRef}
              className="dialog-input"
              value={props.draftValue}
              onChange={(inputEvent) => props.onDraftChange(inputEvent.target.value)}
              placeholder="npub1... または 64 桁 hex"
              inputMode="none"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              aria-label="公開鍵"
            />
            <button
              ref={props.pasteButtonRef}
              type="button"
              className="dialog-icon-button"
              onPointerDown={(event) => {
                event.preventDefault();
                void props.onPaste();
              }}
              onClick={(event) => {
                event.preventDefault();

                if (event.detail === 0) {
                  void props.onPaste();
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
              }}
              disabled={props.isPasting}
              aria-label={
                props.isPasting
                  ? "クリップボードを読み取り中"
                  : "クリップボードから公開鍵を貼り付け"
              }
            >
              <svg
                className="dialog-icon"
                viewBox="0 0 24 24"
                fill="none"
              >
                <rect x="8" y="3" width="8" height="4" rx="1.5" />
                <path d="M8 5H6a2 2 0 0 0-2 2v11a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V7a2 2 0 0 0-2-2h-2" />
                <path d="M9 12h6" />
                <path d="M9 16h4" />
              </svg>
            </button>
          </div>
          {props.errorMessage ? (
            <p className="composer-feedback composer-status-error">
              {props.errorMessage}
            </p>
          ) : props.hintMessage ? (
            <p className="composer-feedback muted">
              {props.hintMessage}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button
              type="button"
              className="dialog-button dialog-button-secondary"
              onClick={props.onClear}
            >
              クリア
            </button>
            <button type="submit" className="dialog-button dialog-button-primary">
              保存
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
