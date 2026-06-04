import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEventHandler,
  type ReactNode,
  type Ref,
} from "react";
import type { TimelineView } from "../app/types";
import { buildFocusedEventHref } from "../lib/nostr/eventRoute";
import { encodeNevent } from "../lib/nostr/nip19";
import {
  formatAuthorLabel,
  formatAuthorNameLabel,
  formatAuthorSubLabel,
  formatAvatarLabel,
  formatPubkey,
  formatReplyContextLabel,
  formatReplyTargetLabel,
} from "../lib/nostr/profilePresentation";
import { sanitizeProfilePictureUrl } from "../lib/nostr/profile";
import {
  formatReactionContentLabel,
  type ReactionIntent,
} from "../lib/nostr/reaction";
import { parseContentSegments } from "../lib/ui/contentSegments";
import { buildAvatarStyle, pubkeyHexColor } from "../lib/ui/avatarStyle";
import { formatCreatedAt, formatCreatedAtParts } from "../lib/ui/formatters";
import { formatReplyPreviewContent } from "../lib/ui/replyPreview";
import type { TimelineItem } from "../lib/wasm/client";

const REPLY_BAND_WIDTH_PX = 5;
const MAX_REPLY_BANDS = 6;

type TimelineCardProps = {
  canReply: boolean;
  canSendReaction: boolean;
  className?: string;
  developerModeEnabled: boolean;
  embeddedDepth?: number;
  embeddedEventIds?: readonly string[];
  isPublishing: boolean;
  isProfileImageEnabled: boolean;
  item: TimelineItem;
  itemRef?: Ref<HTMLLIElement>;
  onCopyEventId: (eventId: string) => void | Promise<void>;
  onPauseTimelineDisplay: () => void;
  onPointerDown?: PointerEventHandler<HTMLLIElement>;
  onReply: (item: TimelineItem) => void | Promise<void>;
  onReact: (item: TimelineItem, reactionIntent: ReactionIntent) => void | Promise<void>;
  onResumeTimelineDisplay: () => void;
  onViewEventJson: (item: TimelineItem) => void | Promise<void>;
  pendingReactionEventIds: readonly string[];
  physicsMode?: boolean;
  readyWriteRelayCount: number;
  referenceItemsById: ReadonlyMap<string, TimelineItem>;
  replyPreviewStatuses: Readonly<Record<string, "hit" | "pending" | "missing">>;
  style?: CSSProperties;
  timelineView: TimelineView;
};

type TimelineCardRenderContext = {
  canReply: boolean;
  canSendReaction: boolean;
  developerModeEnabled: boolean;
  embeddedDepth: number;
  embeddedEventIds: readonly string[];
  isProfileImageEnabled: boolean;
  isPublishing: boolean;
  onCopyEventId: (eventId: string) => void | Promise<void>;
  onPauseTimelineDisplay: () => void;
  onReply: (item: TimelineItem) => void | Promise<void>;
  onReact: (item: TimelineItem, reactionIntent: ReactionIntent) => void | Promise<void>;
  onResumeTimelineDisplay: () => void;
  onViewEventJson: (item: TimelineItem) => void | Promise<void>;
  pendingReactionEventIds: readonly string[];
  physicsMode?: boolean;
  readyWriteRelayCount: number;
  referenceItemsById: ReadonlyMap<string, TimelineItem>;
  replyPreviewStatuses: Readonly<Record<string, "hit" | "pending" | "missing">>;
  timelineView: TimelineView;
};

export function TimelineCard(props: TimelineCardProps) {
  const embeddedDepth = props.embeddedDepth ?? 0;
  const embeddedEventIds = props.embeddedEventIds ?? [props.item.id];
  const isEmbedded = embeddedDepth > 0;
  const displayPubkey = formatPubkey(props.item.pubkey);
  const authorLabel = formatAuthorLabel(props.item, displayPubkey);
  const authorNameLabel = formatAuthorNameLabel(props.item);
  const authorSubLabel = formatAuthorSubLabel(props.item, displayPubkey);
  const avatarLabel = formatAvatarLabel(props.item, displayPubkey);
  const avatarStyle = buildAvatarStyle(props.item.pubkey);
  const replyContextLabel = formatReplyContextLabel(props.item);
  const replyTargetLabel = formatReplyTargetLabel(props.item);
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
  const replyTargetPreviewItem = resolveReplyTargetPreviewItem(
    props.item,
    props.item.replyTargetEventId
      ? props.referenceItemsById.get(props.item.replyTargetEventId) ?? null
      : null,
  );
  const replyTargetPreviewContent = replyTargetPreviewItem
    ? formatReplyPreviewContent(replyTargetPreviewItem)
    : null;
  const replyTargetPreviewSourceItem = replyTargetPreviewItem && (
    replyTargetPreviewItem.pubkey === props.item.replyTargetPubkey
    && props.item.replyTargetProfile
  )
    ? {
        ...replyTargetPreviewItem,
        profile: props.item.replyTargetProfile,
      }
    : replyTargetPreviewItem;
  const replyTargetPreviewPubkey = replyTargetPreviewSourceItem
    ? formatPubkey(replyTargetPreviewSourceItem.pubkey)
    : null;
  const replyTargetPreviewAuthorLabel = replyTargetPreviewSourceItem && replyTargetPreviewPubkey
    ? formatAuthorLabel(replyTargetPreviewSourceItem, replyTargetPreviewPubkey)
    : null;
  const replyTargetPreviewPlaceholderLabel =
    !replyTargetPreviewAuthorLabel && replyTargetLabel
      ? `↪ ${replyTargetLabel}`
      : null;
  const replyTargetPreviewStatus = props.item.replyTargetEventId
    ? props.replyPreviewStatuses[props.item.replyTargetEventId] ?? null
    : null;
  const replyTargetPreviewPlaceholderText = formatReplyPreviewPlaceholderText(
    replyTargetPreviewStatus,
  );
  const isReactionPending = props.pendingReactionEventIds.includes(props.item.id);
  const showReplyButton = !props.physicsMode && props.item.kind === 1 && props.canReply;
  const showReactionButton = !props.physicsMode && props.item.kind === 1;
  const likeCount = props.item.likeCount;
  const kusaCount = props.item.kusaCount ?? 0;
  const moreReactionCount = props.item.moreReactionCount ?? 0;
  const otherReactionSummaries = props.item.otherReactionSummaries ?? [];
  const [isMoreReactionsOpen, setIsMoreReactionsOpen] = useState(false);
  const [isDebugMenuOpen, setIsDebugMenuOpen] = useState(false);
  const moreReactionPopoverRef = useRef<HTMLDivElement | null>(null);
  const debugMenuRef = useRef<HTMLDivElement | null>(null);
  const reactionButtonDisabled =
    props.isPublishing
    || isReactionPending
    || !props.canSendReaction
    || props.readyWriteRelayCount === 0;
  const reactionButtonTitle = !props.canSendReaction
    ? "リアクション送信には署名可能なログインが必要です"
    : props.readyWriteRelayCount === 0
      ? "write relay 接続がまだ準備できていません"
      : isReactionPending
        ? "リアクション送信中です"
        : null;
  const moreReactionSummaryTitle = otherReactionSummaries
    .map((summary) => formatExpandedReactionSummary(summary.content, summary.count))
    .join(" ");
  const renderContext: TimelineCardRenderContext = {
    canReply: props.canReply,
    canSendReaction: props.canSendReaction,
    developerModeEnabled: props.developerModeEnabled,
    embeddedDepth,
    embeddedEventIds,
    isProfileImageEnabled: props.isProfileImageEnabled,
    isPublishing: props.isPublishing,
    onCopyEventId: props.onCopyEventId,
    onPauseTimelineDisplay: props.onPauseTimelineDisplay,
    onReply: props.onReply,
    onReact: props.onReact,
    onResumeTimelineDisplay: props.onResumeTimelineDisplay,
    onViewEventJson: props.onViewEventJson,
    pendingReactionEventIds: props.pendingReactionEventIds,
    physicsMode: props.physicsMode,
    readyWriteRelayCount: props.readyWriteRelayCount,
    referenceItemsById: props.referenceItemsById,
    replyPreviewStatuses: props.replyPreviewStatuses,
    timelineView: props.timelineView,
  };
  const displayContentText = formatTimelineItemContent(
    props.timelineView,
    props.item,
  );
  const displayContent = renderTimelineItemContent({
    content: displayContentText,
    item: props.item,
    renderContext,
  });
  const cardStyle =
    replyBandStyle
      ? {
          paddingInlineStart: `${16 + replyBandStyle.width + 10}px`,
          ...props.style,
        }
      : props.style;
  const cardClassName = `timeline-card${replyBandStyle ? " timeline-card-reply" : ""}${props.physicsMode ? " timeline-card-physics" : ""}${isEmbedded ? " timeline-card-embedded" : ""}${props.className ? ` ${props.className}` : ""}`;

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

  useEffect(() => {
    if (!isDebugMenuOpen || typeof document === "undefined") {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!debugMenuRef.current?.contains(event.target as Node)) {
        setIsDebugMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [isDebugMenuOpen]);

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

  const cardBody = (
    <>
      {props.physicsMode ? (
        <div className="timeline-physics-debug-collider" aria-hidden="true" />
      ) : null}
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
      {replyTargetPreviewItem && replyTargetPreviewContent && replyTargetPreviewAuthorLabel ? (
        <div className="timeline-reply-preview">
          <div className="muted timeline-reply-preview-label">
            {`↪ ${replyTargetPreviewAuthorLabel}`}
          </div>
          <p className="timeline-reply-preview-text">
            {replyTargetPreviewContent}
          </p>
        </div>
      ) : replyTargetPreviewPlaceholderLabel && replyTargetPreviewPlaceholderText ? (
        <div className="timeline-reply-preview timeline-reply-preview-placeholder">
          <div className="muted timeline-reply-preview-label">
            {replyTargetPreviewPlaceholderLabel}
          </div>
          <p className="timeline-reply-preview-text">
            {replyTargetPreviewPlaceholderText}
          </p>
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
      <div className="timeline-text">{displayContent}</div>
      <div className="timeline-actions">
        {showReplyButton ? (
          <button
            type="button"
            className="timeline-reaction-button timeline-reply-button"
            aria-label="返信"
            onClick={() => {
              void props.onReply(props.item);
            }}
          >
            <span aria-hidden="true">↩</span>
            <span>返信</span>
          </button>
        ) : null}
        {showReactionButton ? (
          <>
            <button
              type="button"
              className="timeline-reaction-button"
              disabled={reactionButtonDisabled}
              title={reactionButtonTitle ?? "ふぁぼ"}
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
        {props.developerModeEnabled && !props.physicsMode ? (
          <div ref={debugMenuRef} className="timeline-debug-menu-wrap">
            <button
              type="button"
              className="timeline-debug-menu-button"
              aria-expanded={isDebugMenuOpen}
              aria-label="開発者メニュー"
              onClick={() => {
                setIsDebugMenuOpen((current) => !current);
              }}
            >
              ...
            </button>
            {isDebugMenuOpen ? (
              <div className="timeline-debug-menu-popover" role="menu">
                <button
                  type="button"
                  className="timeline-debug-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setIsDebugMenuOpen(false);
                    void props.onCopyEventId(props.item.id);
                  }}
                >
                  ID をコピー
                </button>
                <button
                  type="button"
                  className="timeline-debug-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setIsDebugMenuOpen(false);
                    void props.onViewEventJson(props.item);
                  }}
                >
                  JSON を確認
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );

  if (isEmbedded) {
    return (
      <div className={cardClassName} style={cardStyle}>
        {cardBody}
      </div>
    );
  }

  return (
    <li
      ref={props.itemRef}
      className={cardClassName}
      style={cardStyle}
      onPointerDown={props.onPointerDown}
    >
      {cardBody}
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

function renderTimelineItemContent(args: {
  content: string;
  item: TimelineItem;
  renderContext: TimelineCardRenderContext;
}): ReactNode {
  const segments = parseContentSegments(args.content);

  return segments.map((segment, index) => {
    if (segment.type === "text") {
      return (
        <Fragment key={`text-${index}`}>
          {segment.text}
        </Fragment>
      );
    }

    if (segment.type === "url") {
      return (
        <a
          key={`url-${segment.href}-${index}`}
          className="timeline-inline-link"
          href={segment.href}
          target="_blank"
          rel="noreferrer noopener"
        >
          {segment.text}
        </a>
      );
    }

    if (segment.type === "event") {
      const embeddedPreviewItem = resolveContentEventPreviewItem(
        args.item,
        segment.eventId,
        args.renderContext.embeddedEventIds,
        args.renderContext.referenceItemsById,
      );

      if (embeddedPreviewItem) {
        return (
          <TimelineCard
            key={`event-embed-${segment.eventId}-${index}`}
            canReply={args.renderContext.canReply}
            canSendReaction={args.renderContext.canSendReaction}
            developerModeEnabled={args.renderContext.developerModeEnabled}
            embeddedDepth={args.renderContext.embeddedDepth + 1}
            embeddedEventIds={[...args.renderContext.embeddedEventIds, embeddedPreviewItem.id]}
            isProfileImageEnabled={args.renderContext.isProfileImageEnabled}
            isPublishing={args.renderContext.isPublishing}
            item={embeddedPreviewItem}
            onCopyEventId={args.renderContext.onCopyEventId}
            onPauseTimelineDisplay={args.renderContext.onPauseTimelineDisplay}
            onReply={args.renderContext.onReply}
            onReact={args.renderContext.onReact}
            onResumeTimelineDisplay={args.renderContext.onResumeTimelineDisplay}
            onViewEventJson={args.renderContext.onViewEventJson}
            pendingReactionEventIds={args.renderContext.pendingReactionEventIds}
            physicsMode={args.renderContext.physicsMode}
            readyWriteRelayCount={args.renderContext.readyWriteRelayCount}
            referenceItemsById={args.renderContext.referenceItemsById}
            replyPreviewStatuses={args.renderContext.replyPreviewStatuses}
            timelineView={args.renderContext.timelineView}
          />
        );
      }

      const focusedEventIdentifier =
        segment.identifier.toLowerCase().startsWith("note1")
          ? encodeNevent(segment.eventId)
          : segment.identifier;
      const href = focusedEventIdentifier
        ? buildFocusedEventHref(focusedEventIdentifier)
        : null;

      if (!href) {
        return (
          <Fragment key={`event-text-${index}`}>
            {segment.text}
          </Fragment>
        );
      }

      return (
        <a
          key={`event-${segment.identifier}-${index}`}
          className="timeline-inline-link timeline-inline-link-event"
          href={href}
          onClick={(event) => {
            handleFocusedEventLinkClick(event, href);
          }}
        >
          {segment.text}
        </a>
      );
    }

    if (segment.type === "mention") {
      return (
        <a
          key={`mention-${segment.identifier}-${index}`}
          className="timeline-inline-link timeline-inline-link-mention"
          href={`nostr:${segment.identifier}`}
        >
          {segment.text}
        </a>
      );
    }

    return (
      <a
        key={`nostr-${segment.href}-${index}`}
        className="timeline-inline-link timeline-inline-link-nostr"
        href={segment.href}
      >
        {segment.text}
      </a>
    );
  });
}

function handleFocusedEventLinkClick(
  event: ReactMouseEvent<HTMLAnchorElement>,
  href: string,
) {
  if (
    event.defaultPrevented
    || event.button !== 0
    || event.metaKey
    || event.ctrlKey
    || event.shiftKey
    || event.altKey
    || typeof window === "undefined"
  ) {
    return;
  }

  event.preventDefault();
  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
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

function resolveReplyTargetPreviewItem(
  item: TimelineItem,
  replyTargetPreviewItem: TimelineItem | null,
) {
  if (
    !item.replyTargetEventId
    || !replyTargetPreviewItem
    || replyTargetPreviewItem.id !== item.replyTargetEventId
    || replyTargetPreviewItem.id === item.id
  ) {
    return null;
  }

  return replyTargetPreviewItem;
}

function resolveContentEventPreviewItem(
  item: TimelineItem,
  eventId: string,
  embeddedEventIds: readonly string[],
  referenceItemsById: ReadonlyMap<string, TimelineItem>,
) {
  const previewItem = referenceItemsById.get(eventId) ?? null;

  if (
    !previewItem
    || previewItem.id === item.id
    || embeddedEventIds.includes(previewItem.id)
  ) {
    return null;
  }

  return previewItem;
}

function formatReplyPreviewPlaceholderText(
  status: "hit" | "pending" | "missing" | null,
) {
  switch (status) {
    case "missing":
      return "返信先ポストはまだ取得できていません";

    default:
      return null;
  }
}

function isCoarsePointerDevice() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia("(pointer: coarse)").matches;
}
