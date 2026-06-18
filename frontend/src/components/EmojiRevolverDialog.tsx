import {
  useEffect,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import {
  DEFAULT_EMOJI_REVOLVER,
  MAX_EMOJI_REVOLVER_SIZE,
  MIN_EMOJI_REVOLVER_SIZE,
  normalizeEmojiRevolverEntry,
} from "../lib/nostr/reaction";

type EmojiRevolverDialogProps = {
  emojis: string[];
  isOpen: boolean;
  onClose: () => void;
  onSave: (emojis: string[]) => void;
};

export function EmojiRevolverDialog(props: EmojiRevolverDialogProps) {
  const [draftEmojis, setDraftEmojis] = useState<string[]>(props.emojis);
  const [newEmojiDraft, setNewEmojiDraft] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!props.isOpen) {
      return;
    }

    setDraftEmojis(props.emojis);
    setNewEmojiDraft("");
    setErrorMessage(null);
  }, [props.emojis, props.isOpen]);

  if (!props.isOpen) {
    return null;
  }

  function handleExistingEmojiChange(index: number, event: ChangeEvent<HTMLInputElement>) {
    setDraftEmojis((current) => current.map((emoji, currentIndex) => (
      currentIndex === index ? event.target.value : emoji
    )));
    setErrorMessage(null);
  }

  function handleAddEmoji() {
    if (draftEmojis.length >= MAX_EMOJI_REVOLVER_SIZE) {
      setErrorMessage(`絵文字レボルバは最大 ${MAX_EMOJI_REVOLVER_SIZE} 個です`);
      return;
    }

    const normalized = normalizeEmojiRevolverEntry(newEmojiDraft);

    if (!normalized) {
      setErrorMessage("追加する値は 1 つの絵文字で入力してください");
      return;
    }

    if (draftEmojis.includes(normalized)) {
      setErrorMessage("同じ絵文字は追加できません");
      return;
    }

    setDraftEmojis((current) => [...current, normalized]);
    setNewEmojiDraft("");
    setErrorMessage(null);
  }

  function handleRemoveEmoji(index: number) {
    if (draftEmojis.length <= MIN_EMOJI_REVOLVER_SIZE) {
      setErrorMessage(`絵文字レボルバは最低 ${MIN_EMOJI_REVOLVER_SIZE} 個必要です`);
      return;
    }

    setDraftEmojis((current) => current.filter((_, currentIndex) => currentIndex !== index));
    setErrorMessage(null);
  }

  function handleRestoreDefaults() {
    setDraftEmojis([...DEFAULT_EMOJI_REVOLVER]);
    setNewEmojiDraft("");
    setErrorMessage(null);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const normalized: string[] = [];

    for (const [index, emoji] of draftEmojis.entries()) {
      const nextEmoji = normalizeEmojiRevolverEntry(emoji);

      if (!nextEmoji) {
        setErrorMessage(`${index + 1} 個目は 1 つの絵文字で入力してください`);
        return;
      }

      if (normalized.includes(nextEmoji)) {
        setErrorMessage("同じ絵文字は登録できません");
        return;
      }

      normalized.push(nextEmoji);
    }

    if (normalized.length < MIN_EMOJI_REVOLVER_SIZE) {
      setErrorMessage(`絵文字レボルバは最低 ${MIN_EMOJI_REVOLVER_SIZE} 個必要です`);
      return;
    }

    if (normalized.length > MAX_EMOJI_REVOLVER_SIZE) {
      setErrorMessage(`絵文字レボルバは最大 ${MAX_EMOJI_REVOLVER_SIZE} 個です`);
      return;
    }

    props.onSave(normalized);
  }

  return (
    <div className="dialog-backdrop" onClick={props.onClose}>
      <div
        className="dialog-panel emoji-revolver-dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="emoji-revolver-title"
        onClick={(dialogEvent) => dialogEvent.stopPropagation()}
      >
        <form className="dialog-form emoji-revolver-dialog-form" onSubmit={handleSubmit}>
          <div className="dialog-copy">
            <h2 id="emoji-revolver-title" className="dialog-title">
              絵文字レボルバ
            </h2>
            <p className="muted dialog-text">
              右端のリアクションリングに出す絵文字を設定します。最小 1、最大 7 です。
            </p>
          </div>

          <div className="emoji-revolver-body">
            <div className="emoji-revolver-list" role="list">
              {draftEmojis.map((emoji, index) => (
                <div key={index} className="emoji-revolver-row" role="listitem">
                  <span className="emoji-revolver-index">{index + 1}</span>
                  <input
                    className="dialog-input emoji-revolver-input"
                    value={emoji}
                    onChange={(event) => {
                      handleExistingEmojiChange(index, event);
                    }}
                    placeholder="😀"
                    aria-label={`${index + 1} 個目の絵文字`}
                  />
                  <button
                    type="button"
                    className="dialog-button dialog-button-secondary emoji-revolver-remove"
                    onClick={() => {
                      handleRemoveEmoji(index);
                    }}
                    disabled={draftEmojis.length <= MIN_EMOJI_REVOLVER_SIZE}
                  >
                    削除
                  </button>
                </div>
              ))}
            </div>

            <div className="emoji-revolver-add-row">
              <input
                className="dialog-input emoji-revolver-input"
                value={newEmojiDraft}
                onChange={(event) => {
                  setNewEmojiDraft(event.target.value);
                  setErrorMessage(null);
                }}
                placeholder="絵文字を 1 つ追加"
                aria-label="追加する絵文字"
              />
              <button
                type="button"
                className="dialog-button dialog-button-secondary"
                onClick={handleAddEmoji}
                disabled={draftEmojis.length >= MAX_EMOJI_REVOLVER_SIZE}
              >
                追加
              </button>
            </div>

            {errorMessage ? (
              <p className="composer-feedback composer-status-error">
                {errorMessage}
              </p>
            ) : null}
          </div>

          <div className="dialog-actions emoji-revolver-actions">
            <button
              type="button"
              className="dialog-button dialog-button-secondary"
              onClick={handleRestoreDefaults}
            >
              既定値
            </button>
            <button
              type="button"
              className="dialog-button dialog-button-secondary"
              onClick={props.onClose}
            >
              閉じる
            </button>
            <button type="submit" className="dialog-button dialog-button-primary">
              保存
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
