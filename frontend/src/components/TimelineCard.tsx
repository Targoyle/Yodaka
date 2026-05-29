import { useEffect, useRef, useState } from "react";
import {
  formatAuthorLabel,
  formatAuthorNameLabel,
  formatAuthorSubLabel,
  formatAvatarLabel,
  formatPubkey,
  formatReplyContextLabel,
} from "../lib/nostr/profilePresentation";
import { sanitizeProfilePictureUrl } from "../lib/nostr/profile";
import {
  formatReactionContentLabel,
  type ReactionIntent,
} from "../lib/nostr/reaction";
import type { TimelineItem } from "../lib/wasm/client";
import { buildAvatarStyle, pubkeyHexColor } from "../lib/ui/avatarStyle";
import { formatCreatedAt, formatCreatedAtParts } from "../lib/ui/formatters";
import type { TimelineView } from "../app/types";

const REPLY_BAND_WIDTH_PX = 5;
const MAX_REPLY_BANDS = 6;

type TimelineCardProps = {
  canSendReaction: boolean;
  isPublishing: boolean;
  isProfileImageEnabled: boolean;
  isReactionPending: boolean;
  item: TimelineItem;
  onPauseTimelineDisplay: () => void;
  onReact: (item: TimelineItem, reactionIntent: ReactionIntent) => void | Promise<void>;
  onResumeTimelineDisplay: () => void;
  readyWriteRelayCount: number;
  timelineView: TimelineView;
};

export function TimelineCard(props: TimelineCardProps) {
  const displayPubkey = formatPubkey(props.item.pubkey);
  const authorLabel = formatAuthorLabel(props.item, displayPubkey);
  const authorNameLabel = formatAuthorNameLabel(props.item);
  const authorSubLabel = formatAuthorSubLabel(props.item, displayPubkey);
  const avatarLabel = formatAvatarLabel(props.item, displayPubkey);
  const avatarStyle = buildAvatarStyle(props.item.pubkey);
  const replyContextLabel = formatReplyContextLabel(props.item);
  const replyBandStyle = buildReplyBandStyle(
    buildTimelineBandPubkeys(props.timelineView, props.item),
  );
  const createdAtParts = formatCreatedAtParts(props.item.createdAt);
  const pictureUrl = sanitizeProfilePictureUrl(props.item.profile?.picture);
  const showProfileImage = props.isProfileImageEnabled && Boolean(pictureUrl);
  const notifyActorItem = props.item.notifyActorPubkey
    ? {
        ...props.item,
        pubkey: props.item.notifyActorPubkey,
        profile: props.item.notifyActorProfile ?? null,
      }
    : null;
  const notifyActorPictureUrl = sanitizeProfilePictureUrl(
    notifyActorItem?.profile?.picture,
  );
  const showNotifyActorProfileImage =
    props.timelineView === "notify"
    && props.item.kind === 7
    && props.isProfileImageEnabled
    && Boolean(notifyActorPictureUrl);
  const notifyActorAvatarLabel = notifyActorItem
    ? formatAvatarLabel(
        notifyActorItem,
        formatPubkey(notifyActorItem.pubkey),
      )
    : null;
  const notifyActorAvatarStyle = notifyActorItem
    ? buildAvatarStyle(notifyActorItem.pubkey)
    : null;
  const notifyLabel = formatNotifyLabel(props.timelineView, props.item, authorLabel);
  const displayContent = formatTimelineItemContent(
    props.timelineView,
    props.item,
  );
  const showReactionButton = props.item.kind === 1;
  const likeCount = props.item.likeCount;
  const kusaCount = props.item.kusaCount ?? 0;
  const moreReactionCount = props.item.moreReactionCount ?? 0;
  const otherReactionSummaries = props.item.otherReactionSummaries ?? [];
  const [isMoreReactionsOpen, setIsMoreReactionsOpen] = useState(false);
  const moreReactionPopoverRef = useRef<HTMLDivElement | null>(null);
  const reactionButtonDisabled =
    props.isPublishing
    || props.isReactionPending
    || !props.canSendReaction
    || props.readyWriteRelayCount === 0;
  const reactionButtonTitle = !props.canSendReaction
    ? "リアクション送信には署名可能なログインが必要です"
    : props.readyWriteRelayCount === 0
      ? "write relay 接続がまだ準備できていません"
      : props.isReactionPending
        ? "リアクション送信中です"
        : null;
  const moreReactionSummaryTitle = otherReactionSummaries
    .map((summary) => formatExpandedReactionSummary(summary.content, summary.count))
    .join(" ");

  useEffect(() => {
    setIsMoreReactionsOpen(false);
  }, [props.item.id]);

  useEffect(() => {
    if (!isMoreReactionsOpen || typeof document === "undefined") {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!moreReactionPopoverRef.current?.contains(event.target as Node)) {
        setIsMoreReactionsOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [isMoreReactionsOpen]);

  function handleMoreReactionsMouseEnter() {
    if (isCoarsePointerDevice() || otherReactionSummaries.length === 0) {
      return;
    }

    props.onPauseTimelineDisplay();
    setIsMoreReactionsOpen(true);
  }

  function handleMoreReactionsMouseLeave() {
    if (isCoarsePointerDevice()) {
      return;
    }

    props.onResumeTimelineDisplay();
    setIsMoreReactionsOpen(false);
  }

  function handleMoreReactionsClick() {
    if (!isCoarsePointerDevice() || otherReactionSummaries.length === 0) {
      return;
    }

    setIsMoreReactionsOpen((current) => !current);
  }

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
      {notifyLabel ? (
        <div className="muted timeline-reply-context">
          {notifyLabel}
        </div>
      ) : null}
      <div className="timeline-header">
        <div className="timeline-avatar-stack">
          <div className="timeline-avatar timeline-avatar-primary" style={avatarStyle}>
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
          {notifyActorItem && notifyActorAvatarStyle ? (
            <div className="timeline-avatar timeline-avatar-notify" style={notifyActorAvatarStyle}>
              {showNotifyActorProfileImage ? (
                <img
                  className="timeline-avatar-image"
                  src={notifyActorPictureUrl ?? undefined}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span className="timeline-avatar-fallback" aria-hidden="true">
                  {notifyActorAvatarLabel}
                </span>
              )}
            </div>
          ) : null}
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
      <p className="timeline-text">{displayContent}</p>
      <div className="timeline-actions">
        {showReactionButton ? (
          <>
            <button
              type="button"
              className="timeline-reaction-button"
              disabled={reactionButtonDisabled}
              title={reactionButtonTitle ?? "like / upvote を送信"}
              aria-label={`★ ${likeCount}`}
              onMouseEnter={props.onPauseTimelineDisplay}
              onMouseLeave={props.onResumeTimelineDisplay}
              onClick={() => {
                void props.onReact(props.item, "like");
              }}
            >
              <span aria-hidden="true">★</span>
              <span>{likeCount}</span>
            </button>
            <button
              type="button"
              className="timeline-reaction-button"
              disabled={reactionButtonDisabled}
              title={reactionButtonTitle ?? "草リアクションを送信"}
              aria-label={`草 ${kusaCount}`}
              onMouseEnter={props.onPauseTimelineDisplay}
              onMouseLeave={props.onResumeTimelineDisplay}
              onClick={() => {
                void props.onReact(props.item, "kusa");
              }}
            >
              <span aria-hidden="true">草</span>
              <span>{kusaCount}</span>
            </button>
            {moreReactionCount > 0 ? (
              <div
                ref={moreReactionPopoverRef}
                className="timeline-reaction-summary-wrap"
                onMouseEnter={handleMoreReactionsMouseEnter}
                onMouseLeave={handleMoreReactionsMouseLeave}
              >
                <button
                  type="button"
                  className="timeline-reaction-summary"
                  title={moreReactionSummaryTitle || "その他のリアクション数"}
                  aria-expanded={isMoreReactionsOpen}
                  onClick={handleMoreReactionsClick}
                >
                  {`more ${moreReactionCount}`}
                </button>
                {isMoreReactionsOpen && otherReactionSummaries.length > 0 ? (
                  <div className="timeline-reaction-popover" role="list">
                    {otherReactionSummaries.map((summary) => (
                      <span
                        key={`${summary.content}-${summary.count}`}
                        className="timeline-reaction-popover-item"
                        role="listitem"
                      >
                        {formatExpandedReactionSummary(summary.content, summary.count)}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
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

function buildTimelineBandPubkeys(timelineView: TimelineView, item: TimelineItem) {
  if (timelineView === "notify" && item.kind === 7 && item.notifyActorPubkey) {
    return [item.notifyActorPubkey, ...item.replyContextPubkeys];
  }

  return item.replyContextPubkeys;
}

function formatTimelineItemContent(
  timelineView: TimelineView,
  item: TimelineItem,
) {
  if (timelineView === "notify" && item.kind === 7) {
    return item.content;
  }

  if (item.kind === 7) {
    return formatReactionContentLabel(item.content);
  }

  return item.content;
}

function formatNotifyLabel(
  timelineView: TimelineView,
  item: TimelineItem,
  fallbackAuthorLabel: string,
) {
  if (timelineView !== "notify") {
    return null;
  }

  if (item.kind === 7) {
    const actorPubkey = item.notifyActorPubkey ? formatPubkey(item.notifyActorPubkey) : null;
    const actorItem = item.notifyActorPubkey
      ? {
          ...item,
          pubkey: item.notifyActorPubkey,
          profile: item.notifyActorProfile ?? null,
        }
      : null;
    const actorLabel = actorItem
      ? formatAuthorLabel(actorItem, actorPubkey ?? fallbackAuthorLabel)
      : fallbackAuthorLabel;

    return `${actorLabel} ${formatReactionBadgeLabel(item.notifyReactionContent ?? item.content)}`;
  }

  return null;
}

function formatReactionBadgeLabel(content: string) {
  return formatReactionContentLabel(content);
}

function formatExpandedReactionSummary(content: string, count: number) {
  const label = formatReactionContentLabel(content);

  return count > 1 ? `${label} ${count}` : label;
}

function isCoarsePointerDevice() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia("(pointer: coarse)").matches;
}
