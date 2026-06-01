type EventJsonDialogProps = {
  isOpen: boolean;
  jsonText: string;
  title: string;
  onClose: () => void;
  onCopy: () => void | Promise<void>;
};

export function EventJsonDialog(props: EventJsonDialogProps) {
  if (!props.isOpen) {
    return null;
  }

  return (
    <div
      className="dialog-backdrop"
      onClick={props.onClose}
      role="presentation"
    >
      <section
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="event-json-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-form">
          <div className="dialog-copy">
            <h2 id="event-json-title" className="dialog-title">
              {props.title}
            </h2>
          </div>
          <pre className="event-json-pre">{props.jsonText}</pre>
          <div className="dialog-actions">
            <button
              type="button"
              className="dialog-button dialog-button-secondary"
              onClick={() => {
                void props.onCopy();
              }}
            >
              コピー
            </button>
            <button
              type="button"
              className="dialog-button dialog-button-secondary"
              onClick={props.onClose}
            >
              閉じる
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
