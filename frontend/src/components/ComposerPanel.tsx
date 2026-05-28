import type {
  ChangeEventHandler,
  FormEventHandler,
  KeyboardEventHandler,
} from "react";

type ComposerPanelProps = {
  draftContent: string;
  errorMessage: string | null;
  isPublishing: boolean;
  readyWriteRelayCount: number;
  statusMessage: string | null;
  onClearFeedback: () => void;
  onDraftChange: (value: string) => void;
  onDraftKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  onSubmit: FormEventHandler<HTMLFormElement>;
};

export function ComposerPanel(props: ComposerPanelProps) {
  const submitDisabled =
    props.isPublishing
    || props.readyWriteRelayCount === 0
    || props.draftContent.trim().length === 0;

  const handleDraftChange: ChangeEventHandler<HTMLTextAreaElement> = (event) => {
    props.onDraftChange(event.target.value);
    props.onClearFeedback();
  };

  return (
    <section className="panel composer-panel">
      <form
        className="composer-form"
        onSubmit={props.onSubmit}
        autoComplete="off"
        data-1p-ignore="true"
        data-bwignore="true"
        data-lpignore="true"
      >
        <textarea
          className="composer-textarea"
          value={props.draftContent}
          onKeyDown={props.onDraftKeyDown}
          onChange={handleDraftChange}
          placeholder="kind 1 を投稿"
          name="nostr-note-content"
          rows={1}
          maxLength={8 * 1024}
          autoComplete="off"
          autoCorrect="on"
          autoCapitalize="sentences"
          spellCheck
          enterKeyHint="send"
          data-1p-ignore="true"
          data-bwignore="true"
          data-lpignore="true"
          disabled={props.isPublishing}
        />
        <div className="composer-actions">
          <div className="composer-status-area">
            {props.errorMessage ? (
              <p className="composer-feedback composer-status-error">
                {props.errorMessage}
              </p>
            ) : props.statusMessage ? (
              <p className="composer-feedback muted">{props.statusMessage}</p>
            ) : null}
          </div>
          <button
            type="submit"
            className="composer-submit"
            disabled={submitDisabled}
          >
            {props.isPublishing ? "ポスト中..." : "ポスト"}
          </button>
        </div>
      </form>
    </section>
  );
}
