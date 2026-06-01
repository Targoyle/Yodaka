import { useEffect, useMemo, useRef, useState } from "react";
import type { AuxiliaryTimelineDiagnostic, TimelineView } from "../app/types";
import type { ReactionIntent } from "../lib/nostr/reaction";
import { formatRecordedAt } from "../lib/ui/formatters";
import type { TimelineItem } from "../lib/wasm/client";
import { TimelineCard } from "./TimelineCard";

type TimelinePanelProps = {
  accountTabEnabled: boolean;
  canOpenPersonalTimeline: boolean;
  canSendReaction: boolean;
  developerModeEnabled: boolean;
  emptyMessage: string;
  isProfileImageEnabled: boolean;
  isPublishing: boolean;
  notifyTabEnabled: boolean;
  onCopyEventId: (eventId: string) => void | Promise<void>;
  pendingReactionEventIds: string[];
  readyWriteRelayCount: number;
  reactionTabEnabled: boolean;
  relayButtonTitle: string;
  timelineDiagnostics: AuxiliaryTimelineDiagnostic[];
  timelineReferenceItems: TimelineItem[];
  timelineView: TimelineView;
  onReact: (item: TimelineItem, reactionIntent: ReactionIntent) => void | Promise<void>;
  onTimelineViewChange: (view: TimelineView) => void | Promise<void>;
  onViewEventJson: (item: TimelineItem) => void | Promise<void>;
  visibleTimeline: TimelineItem[];
};

export function TimelinePanel(props: TimelinePanelProps) {
  const [isHoverFreezeEnabled, setIsHoverFreezeEnabled] = useState(() =>
    typeof window === "undefined" || typeof window.matchMedia !== "function"
      ? true
      : !window.matchMedia("(pointer: coarse)").matches,
  );
  const [timelineDisplayPaused, setTimelineDisplayPaused] = useState(false);
  const [pausedVisibleTimeline, setPausedVisibleTimeline] = useState<TimelineItem[] | null>(
    null,
  );
  const visibleTimelineRef = useRef<TimelineItem[]>(props.visibleTimeline);
  const hoveredReactionButtonCountRef = useRef(0);
  const reactionPauseReleaseTimerRef = useRef<number | null>(null);
  visibleTimelineRef.current = props.visibleTimeline;

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(pointer: coarse)");
    const updateFreezeMode = () => {
      setIsHoverFreezeEnabled(!mediaQuery.matches);
    };

    updateFreezeMode();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", updateFreezeMode);

      return () => {
        mediaQuery.removeEventListener("change", updateFreezeMode);
      };
    }

    mediaQuery.addListener(updateFreezeMode);

    return () => {
      mediaQuery.removeListener(updateFreezeMode);
    };
  }, []);

  useEffect(() => {
    if (isHoverFreezeEnabled) {
      return;
    }

    hoveredReactionButtonCountRef.current = 0;
    clearReactionPauseReleaseTimer();
    setTimelineDisplayPaused(false);
    setPausedVisibleTimeline(null);
  }, [isHoverFreezeEnabled]);

  useEffect(() => {
    return () => {
      if (
        reactionPauseReleaseTimerRef.current === null
        || typeof window === "undefined"
      ) {
        return;
      }

      window.clearTimeout(reactionPauseReleaseTimerRef.current);
    };
  }, []);

  function clearReactionPauseReleaseTimer() {
    if (
      reactionPauseReleaseTimerRef.current === null
      || typeof window === "undefined"
    ) {
      return;
    }

    window.clearTimeout(reactionPauseReleaseTimerRef.current);
    reactionPauseReleaseTimerRef.current = null;
  }

  function pauseTimelineDisplay() {
    if (!isHoverFreezeEnabled) {
      return;
    }

    clearReactionPauseReleaseTimer();
    hoveredReactionButtonCountRef.current += 1;

    if (hoveredReactionButtonCountRef.current > 1) {
      return;
    }

    setPausedVisibleTimeline(visibleTimelineRef.current);
    setTimelineDisplayPaused(true);
  }

  function resumeTimelineDisplay() {
    if (!isHoverFreezeEnabled) {
      return;
    }

    hoveredReactionButtonCountRef.current = Math.max(
      0,
      hoveredReactionButtonCountRef.current - 1,
    );

    if (hoveredReactionButtonCountRef.current !== 0) {
      return;
    }

    if (typeof window === "undefined") {
      setTimelineDisplayPaused(false);
      setPausedVisibleTimeline(null);
      return;
    }

    clearReactionPauseReleaseTimer();
    reactionPauseReleaseTimerRef.current = window.setTimeout(() => {
      reactionPauseReleaseTimerRef.current = null;

      if (hoveredReactionButtonCountRef.current !== 0) {
        return;
      }

      setTimelineDisplayPaused(false);
      setPausedVisibleTimeline(null);
    }, 0);
  }

  const displayedTimeline =
    timelineDisplayPaused && pausedVisibleTimeline !== null
      ? pausedVisibleTimeline
      : props.visibleTimeline;
  const referenceById = useMemo(() => {
    const next = new Map<string, TimelineItem>();

    for (const item of props.timelineReferenceItems) {
      next.set(item.id, item);
    }

    for (const item of displayedTimeline) {
      next.set(item.id, item);
    }

    return next;
  }, [displayedTimeline, props.timelineReferenceItems]);

  return (
    <section className="panel">
      <div className="section-heading">
        <h2 className="section-chip timeline-heading-chip">Timeline</h2>
        <div className="view-switcher" role="group" aria-label="タイムライン切替">
          <button
            type="button"
            className={`view-button${props.timelineView === "relay" ? " view-button-active" : ""}`}
            onClick={() => {
              void props.onTimelineViewChange("relay");
            }}
            title={props.relayButtonTitle}
          >
            Relay
          </button>
          <button
            type="button"
            className={`view-button${props.timelineView === "follow" ? " view-button-active" : ""}`}
            onClick={() => {
              void props.onTimelineViewChange("follow");
            }}
            disabled={!props.canOpenPersonalTimeline}
            title={
              !props.canOpenPersonalTimeline
                ? "公開鍵の入力または NIP-07 が必要です"
                : "Follow"
            }
          >
            Follow
          </button>
          {props.accountTabEnabled ? (
            <button
              type="button"
              className={`view-button${props.timelineView === "account" ? " view-button-active" : ""}`}
              onClick={() => {
                void props.onTimelineViewChange("account");
              }}
              disabled={!props.canOpenPersonalTimeline}
              title={
                !props.canOpenPersonalTimeline
                  ? "公開鍵の入力または NIP-07 が必要です"
                  : "Account"
              }
            >
              Account
            </button>
          ) : null}
          {props.notifyTabEnabled ? (
            <button
              type="button"
              className={`view-button${props.timelineView === "notify" ? " view-button-active" : ""}`}
              onClick={() => {
                void props.onTimelineViewChange("notify");
              }}
              disabled={!props.canOpenPersonalTimeline}
              title={
                !props.canOpenPersonalTimeline
                  ? "公開鍵の入力または NIP-07 が必要です"
                  : "Notify"
              }
            >
              Notify
            </button>
          ) : null}
          {props.reactionTabEnabled ? (
            <button
              type="button"
              className={`view-button${props.timelineView === "reaction" ? " view-button-active" : ""}`}
              onClick={() => {
                void props.onTimelineViewChange("reaction");
              }}
              disabled={!props.canOpenPersonalTimeline}
              title={
                !props.canOpenPersonalTimeline
                  ? "公開鍵の入力または NIP-07 が必要です"
                  : "Reaction"
              }
            >
              Reaction
            </button>
          ) : null}
        </div>
      </div>

      {props.developerModeEnabled && props.timelineDiagnostics.length > 0 ? (
        <div className="timeline-diagnostics">
          {props.timelineDiagnostics.map((diagnostic) => (
            <p key={diagnostic.label} className="timeline-diagnostic-line">
              <span className="timeline-diagnostic-label">{diagnostic.label}</span>
              <span className="timeline-diagnostic-value">
                {formatAuxiliaryDiagnostic(diagnostic)}
              </span>
            </p>
          ))}
        </div>
      ) : null}

      {displayedTimeline.length === 0 ? (
        <p className="muted">{props.emptyMessage}</p>
      ) : (
        <ul className="list">
          {displayedTimeline.map((item) => {
            const isReactionPending = props.pendingReactionEventIds.includes(item.id);
            const replyTargetPreviewItem = item.replyTargetEventId
              ? referenceById.get(item.replyTargetEventId) ?? null
              : null;

            return (
              <TimelineCard
                key={item.id}
                canSendReaction={props.canSendReaction}
                developerModeEnabled={props.developerModeEnabled}
                isProfileImageEnabled={props.isProfileImageEnabled}
                isPublishing={props.isPublishing}
                isReactionPending={isReactionPending}
                item={item}
                onCopyEventId={props.onCopyEventId}
                onPauseTimelineDisplay={pauseTimelineDisplay}
                onReact={props.onReact}
                onResumeTimelineDisplay={resumeTimelineDisplay}
                onViewEventJson={props.onViewEventJson}
                readyWriteRelayCount={props.readyWriteRelayCount}
                replyTargetPreviewItem={replyTargetPreviewItem}
                timelineView={props.timelineView}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}

function formatAuxiliaryDiagnostic(diagnostic: AuxiliaryTimelineDiagnostic) {
  const parts = [
    formatAuxiliaryLoadStateLabel(diagnostic.loadState),
    `read ${diagnostic.readyReadRelayCount}/${diagnostic.relayCount}`,
    `items ${diagnostic.itemCount}`,
  ];

  if (diagnostic.summary) {
    parts.push(diagnostic.summary);
  }

  if (diagnostic.lastFetchedAt) {
    parts.push(`fetch ${formatRecordedAt(diagnostic.lastFetchedAt)}`);
  }

  if (diagnostic.liveEventCount !== null) {
    parts.push(`live ${diagnostic.liveEventCount}`);
  }

  if (diagnostic.lastEventAt) {
    parts.push(`event ${formatRecordedAt(diagnostic.lastEventAt)}`);
  }

  if (diagnostic.loadState === "error" && diagnostic.error) {
    parts.push(diagnostic.error);
  }

  return parts.join(" · ");
}

function formatAuxiliaryLoadStateLabel(loadState: AuxiliaryTimelineDiagnostic["loadState"]) {
  switch (loadState) {
    case "waiting":
      return "WAIT";
    case "loading":
      return "LOAD";
    case "ready":
      return "READY";
    case "listening":
      return "LISTEN";
    case "error":
      return "ERROR";
    default:
      return "IDLE";
  }
}
