import type {
  ChangeEventHandler,
  FormEventHandler,
  KeyboardEventHandler,
  Ref,
} from "react";
import {
  formatAuthorLabel,
  formatPubkey,
} from "../lib/nostr/profilePresentation";
import { formatReplyPreviewContent } from "../lib/ui/replyPreview";
import type { TimelineItem } from "../lib/wasm/client";

type ComposerPanelProps = {
  draftContent: string;
  errorMessage: string | null;
  isPublishing: boolean;
  noticeMessage: string | null;
  readyWriteRelayCount: number;
  replyTargetItem: TimelineItem | null;
  statusMessage: string | null;
  onClearFeedback: () => void;
  onDraftChange: (value: string) => void;
  onDraftKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  onReplyCancel: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  textareaRef?: Ref<HTMLTextAreaElement>;
};

export function ComposerPanel(props: ComposerPanelProps) {
  const submitDisabled =
    props.isPublishing
    || props.readyWriteRelayCount === 0
    || props.draftContent.trim().length === 0;
  const replyTargetPubkey = props.replyTargetItem
    ? formatPubkey(props.replyTargetItem.pubkey)
    : null;
  const replyTargetLabel = props.replyTargetItem && replyTargetPubkey
    ? formatAuthorLabel(props.replyTargetItem, replyTargetPubkey)
    : null;
  const replyTargetPreview = props.replyTargetItem
    ? formatReplyPreviewContent(props.replyTargetItem)
    : null;

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
        {props.replyTargetItem && replyTargetLabel ? (
          <div className="composer-reply-preview">
            <div className="composer-reply-row">
              <div className="composer-reply-copy">
                <p className="composer-reply-label">
                  {`↪ ${replyTargetLabel} へ返信`}
                </p>
                {replyTargetPreview ? (
                  <p className="composer-reply-text">
                    {replyTargetPreview}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                className="composer-reply-cancel"
                onClick={props.onReplyCancel}
                disabled={props.isPublishing}
              >
                取消
              </button>
            </div>
          </div>
        ) : null}
        <textarea
          ref={props.textareaRef}
          className="composer-textarea"
          value={props.draftContent}
          onKeyDown={props.onDraftKeyDown}
          onChange={handleDraftChange}
          placeholder={props.replyTargetItem ? "リプライを書く" : "kind 1 を投稿"}
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
            {props.noticeMessage ? (
              <p className="composer-feedback composer-status-notice">
                {props.noticeMessage}
              </p>
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
