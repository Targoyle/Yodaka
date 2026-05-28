import {
  formatAuthorLabel,
  formatAuthorNameLabel,
  formatAuthorSubLabel,
  formatAvatarLabel,
  formatPubkey,
  formatReplyContextLabel,
} from "../lib/nostr/profilePresentation";
import { sanitizeProfilePictureUrl } from "../lib/nostr/profile";
import type { TimelineItem } from "../lib/wasm/client";
import { buildAvatarStyle, pubkeyHexColor } from "../lib/ui/avatarStyle";
import { formatCreatedAt, formatCreatedAtParts } from "../lib/ui/formatters";

const REPLY_BAND_WIDTH_PX = 5;
const MAX_REPLY_BANDS = 6;

type TimelineCardProps = {
  canSendReaction: boolean;
  isPublishing: boolean;
  isProfileImageEnabled: boolean;
  isReactionPending: boolean;
  item: TimelineItem;
  onPauseTimelineDisplay: () => void;
  onReact: (item: TimelineItem) => void | Promise<void>;
  onResumeTimelineDisplay: () => void;
  readyWriteRelayCount: number;
};

export function TimelineCard(props: TimelineCardProps) {
  const displayPubkey = formatPubkey(props.item.pubkey);
  const authorLabel = formatAuthorLabel(props.item, displayPubkey);
  const authorNameLabel = formatAuthorNameLabel(props.item);
  const authorSubLabel = formatAuthorSubLabel(props.item, displayPubkey);
  const avatarLabel = formatAvatarLabel(props.item, displayPubkey);
  const avatarStyle = buildAvatarStyle(props.item.pubkey);
  const replyContextLabel = formatReplyContextLabel(props.item);
  const replyBandStyle = buildReplyBandStyle(props.item.replyContextPubkeys);
  const createdAtParts = formatCreatedAtParts(props.item.createdAt);
  const pictureUrl = sanitizeProfilePictureUrl(props.item.profile?.picture);
  const showProfileImage = props.isProfileImageEnabled && Boolean(pictureUrl);
  const reactionButtonDisabled =
    props.isPublishing
    || props.isReactionPending
    || !props.canSendReaction
    || props.readyWriteRelayCount === 0;
  const reactionButtonTitle = !props.canSendReaction
    ? "リアクション送信には署名可能なログインが必要です"
    : props.readyWriteRelayCount === 0
      ? "write relay 接続がまだ準備できていません"
      : "empty リアクション (like / upvote) を送信";

  return (
    <li
      className={`timeline-card${replyBandStyle ? " timeline-card-reply" : ""}`}
      style={
        replyBandStyle
          ? {
              paddingInlineStart: `${16 + replyBandStyle.width + 10}px`,
            }
          : undefined
      }
    >
      {replyBandStyle ? (
        <div
          className="timeline-reply-bands"
          style={{
            width: `${replyBandStyle.width}px`,
            background: replyBandStyle.background,
          }}
          aria-hidden="true"
        />
      ) : null}
      {replyContextLabel ? (
        <div className="muted timeline-reply-context">
          {replyContextLabel}
        </div>
      ) : null}
      <div className="timeline-header">
        <div className="timeline-avatar" style={avatarStyle}>
          {showProfileImage ? (
            <img
              className="timeline-avatar-image"
              src={pictureUrl ?? undefined}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          ) : (
            <span className="timeline-avatar-fallback" aria-hidden="true">
              {avatarLabel}
            </span>
          )}
        </div>
        <div className="timeline-identity">
          <div className="timeline-author-row">
            <strong className="timeline-author" title={displayPubkey}>
              {authorLabel}
            </strong>
            {authorNameLabel ? (
              <span className="muted timeline-author-name">
                {authorNameLabel}
              </span>
            ) : null}
          </div>
          {authorSubLabel ? (
            <div className="muted timeline-pubkey" title={displayPubkey}>
              {authorSubLabel}
            </div>
          ) : null}
        </div>
      </div>
      <p className="timeline-text">{props.item.content}</p>
      <div className="timeline-actions">
        <button
          type="button"
          className="timeline-reaction-button"
          disabled={reactionButtonDisabled}
          title={reactionButtonTitle}
          onMouseEnter={props.onPauseTimelineDisplay}
          onMouseLeave={props.onResumeTimelineDisplay}
          onClick={() => {
            void props.onReact(props.item);
          }}
        >
          <span aria-hidden="true">♡</span>
          <span>{props.item.likeCount}</span>
          <span className="timeline-reaction-label">
            {props.isReactionPending ? "送信中..." : "Like"}
          </span>
        </button>
        <time
          className="muted timeline-meta"
          dateTime={new Date(props.item.createdAt * 1000).toISOString()}
          title={formatCreatedAt(props.item.createdAt)}
        >
          <span className="timeline-meta-date">{createdAtParts.date}</span>
          <span className="timeline-meta-separator" aria-hidden="true"> </span>
          <span className="timeline-meta-time">{createdAtParts.time}</span>
        </time>
      </div>
    </li>
  );
}

function buildReplyBandStyle(pubkeys: string[]) {
  const colors = [...new Set(pubkeys)].map((pubkey) => pubkeyHexColor(pubkey));

  if (colors.length === 0) {
    return null;
  }

  if (colors.length > MAX_REPLY_BANDS) {
    return {
      width: REPLY_BAND_WIDTH_PX * MAX_REPLY_BANDS,
      background:
        "linear-gradient(180deg, #ff6b6b 0%, #ffa94d 16.66%, #ffe066 33.33%, #69db7c 50%, #4dabf7 66.66%, #9775fa 83.33%, #f06595 100%)",
    };
  }

  return {
    width: REPLY_BAND_WIDTH_PX * colors.length,
    background: `linear-gradient(90deg, ${colors
      .map((color, index) => {
        const start = (100 / colors.length) * index;
        const end = (100 / colors.length) * (index + 1);

        return `${color} ${start}%, ${color} ${end}%`;
      })
      .join(", ")})`,
  };
}
