import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { AuxiliaryTimelineDiagnostic, TimelineView } from "../app/types";
import type { ReactionIntent } from "../lib/nostr/reaction";
import { formatRecordedAt } from "../lib/ui/formatters";
import type { TimelineItem } from "../lib/wasm/client";
import {
  GravityWorld,
  type GravityBodySeed,
  type GravityBodySnapshot,
} from "../lib/wasm/gravity";
import { TimelineCard } from "./TimelineCard";

const PHYSICS_CARD_GUTTER_PX = 16;
const PHYSICS_CARD_INLINE_SIZE_PX = 360;
const PHYSICS_CARD_FALLBACK_HEIGHT_PX = 180;
const PHYSICS_NEW_ITEM_SPAWN_Y_PX = 24;
const PHYSICS_INITIAL_STACK_OVERLAP_PX = 56;

type TimelinePanelProps = {
  accountTabEnabled: boolean;
  canOpenPersonalTimeline: boolean;
  canSendReaction: boolean;
  developerModeEnabled: boolean;
  emptyMessage: string;
  focusedEventMode: boolean;
  isProfileImageEnabled: boolean;
  isPublishing: boolean;
  notifyTabEnabled: boolean;
  onCopyEventId: (eventId: string) => void | Promise<void>;
  pendingReactionEventIds: string[];
  physicsEnabled: boolean;
  readyWriteRelayCount: number;
  reactionTabEnabled: boolean;
  relayButtonTitle: string;
  replyPreviewStatuses: Record<string, "hit" | "pending" | "missing">;
  timelineDiagnostics: AuxiliaryTimelineDiagnostic[];
  timelineHeadingLabel: string;
  timelineReferenceItems: TimelineItem[];
  timelineView: TimelineView;
  onReact: (item: TimelineItem, reactionIntent: ReactionIntent) => void | Promise<void>;
  onTimelineViewChange: (view: TimelineView) => void | Promise<void>;
  onViewEventJson: (item: TimelineItem) => void | Promise<void>;
  visibleTimeline: TimelineItem[];
};

type ViewportSize = {
  width: number;
  height: number;
};

export function TimelinePanel(props: TimelinePanelProps) {
  const activeTimelineView = props.focusedEventMode ? null : props.timelineView;
  const [isHoverFreezeEnabled, setIsHoverFreezeEnabled] = useState(() =>
    typeof window === "undefined" || typeof window.matchMedia !== "function"
      ? true
      : !window.matchMedia("(pointer: coarse)").matches,
  );
  const [timelineDisplayPaused, setTimelineDisplayPaused] = useState(false);
  const [pausedVisibleTimeline, setPausedVisibleTimeline] = useState<TimelineItem[] | null>(
    null,
  );
  const [physicsTimelineSnapshot, setPhysicsTimelineSnapshot] = useState<TimelineItem[] | null>(
    null,
  );
  const [physicsSnapshots, setPhysicsSnapshots] = useState<GravityBodySnapshot[] | null>(null);
  const [physicsWorldReady, setPhysicsWorldReady] = useState(false);
  const [physicsPendingMeasureIds, setPhysicsPendingMeasureIds] = useState<string[]>([]);
  const [physicsViewportSize, setPhysicsViewportSize] = useState<ViewportSize>({
    width: 0,
    height: 0,
  });
  const visibleTimelineRef = useRef<TimelineItem[]>(props.visibleTimeline);
  const hoveredReactionButtonCountRef = useRef(0);
  const reactionPauseReleaseTimerRef = useRef<number | null>(null);
  const physicsStageRef = useRef<HTMLDivElement | null>(null);
  const physicsMeasureRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const physicsWorldRef = useRef<GravityWorld | null>(null);
  const physicsFrameRef = useRef<number | null>(null);
  const physicsLastFrameAtRef = useRef<number | null>(null);
  const physicsDragPointerIdRef = useRef<number | null>(null);
  const physicsSourceViewRef = useRef<TimelineView | null>(null);
  const physicsTimelineSnapshotRef = useRef<TimelineItem[] | null>(null);
  const physicsSnapshotsRef = useRef<GravityBodySnapshot[] | null>(null);
  const physicsKnownItemIdsRef = useRef<Set<string>>(new Set());
  visibleTimelineRef.current = props.visibleTimeline;
  physicsTimelineSnapshotRef.current = physicsTimelineSnapshot;
  physicsSnapshotsRef.current = physicsSnapshots;

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

  useEffect(() => {
    if (!props.physicsEnabled || typeof window === "undefined") {
      setPhysicsViewportSize({
        width: 0,
        height: 0,
      });
      return;
    }

    const updateViewportSize = () => {
      setPhysicsViewportSize({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };

    updateViewportSize();
    window.addEventListener("resize", updateViewportSize);

    return () => {
      window.removeEventListener("resize", updateViewportSize);
    };
  }, [props.physicsEnabled]);

  useEffect(() => {
    if (!props.physicsEnabled || typeof window === "undefined") {
      return;
    }

    const html = document.documentElement;
    const body = document.body;
    const scrollY = window.scrollY;
    const previousHtmlOverflow = html.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    const previousBodyPosition = body.style.position;
    const previousBodyTop = body.style.top;
    const previousBodyInlineSize = body.style.width;
    const previousBodyInsetInlineStart = body.style.left;
    const previousBodyInsetInlineEnd = body.style.right;

    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.width = "100%";
    body.style.left = "0";
    body.style.right = "0";

    return () => {
      html.style.overflow = previousHtmlOverflow;
      body.style.overflow = previousBodyOverflow;
      body.style.position = previousBodyPosition;
      body.style.top = previousBodyTop;
      body.style.width = previousBodyInlineSize;
      body.style.left = previousBodyInsetInlineStart;
      body.style.right = previousBodyInsetInlineEnd;
      window.scrollTo({
        top: scrollY,
        left: 0,
        behavior: "instant",
      });
    };
  }, [props.physicsEnabled]);

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
    if (!isHoverFreezeEnabled || props.physicsEnabled) {
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
    if (!isHoverFreezeEnabled || props.physicsEnabled) {
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

  const visibleCards = props.physicsEnabled
    ? physicsTimelineSnapshot ?? displayedTimeline
    : displayedTimeline;

  const referenceById = useMemo(() => {
    const next = new Map<string, TimelineItem>();

    for (const item of props.timelineReferenceItems) {
      next.set(item.id, item);
    }

    for (const item of visibleCards) {
      next.set(item.id, item);
    }

    return next;
  }, [props.timelineReferenceItems, visibleCards]);

  const physicsPendingItems = useMemo(() => {
    if (!physicsTimelineSnapshot || physicsPendingMeasureIds.length === 0) {
      return [];
    }

    const pendingIdSet = new Set(physicsPendingMeasureIds);
    return physicsTimelineSnapshot.filter((item) => pendingIdSet.has(item.id));
  }, [physicsPendingMeasureIds, physicsTimelineSnapshot]);

  function teardownPhysicsWorld() {
    if (physicsFrameRef.current !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(physicsFrameRef.current);
      physicsFrameRef.current = null;
    }

    physicsLastFrameAtRef.current = null;
    physicsDragPointerIdRef.current = null;
    physicsWorldRef.current = null;
  }

  useEffect(() => {
    if (!props.physicsEnabled) {
      physicsSourceViewRef.current = null;
      physicsKnownItemIdsRef.current = new Set();
      teardownPhysicsWorld();
      setPhysicsTimelineSnapshot(null);
      setPhysicsSnapshots(null);
      setPhysicsWorldReady(false);
      setPhysicsPendingMeasureIds([]);
      return;
    }

    if (
      physicsTimelineSnapshotRef.current === null
      || physicsSourceViewRef.current !== props.timelineView
    ) {
      physicsSourceViewRef.current = props.timelineView;
      physicsKnownItemIdsRef.current = new Set(displayedTimeline.map((item) => item.id));
      teardownPhysicsWorld();
      setPhysicsTimelineSnapshot(displayedTimeline);
      setPhysicsSnapshots(null);
      setPhysicsWorldReady(false);
      setPhysicsPendingMeasureIds([]);
    }
  }, [displayedTimeline, props.physicsEnabled, props.timelineView]);

  useEffect(() => {
    if (
      !props.physicsEnabled
      || !physicsWorldReady
      || !physicsTimelineSnapshotRef.current
      || physicsSourceViewRef.current !== props.timelineView
      || physicsViewportSize.width <= 0
    ) {
      return;
    }

    const currentTimeline = physicsTimelineSnapshotRef.current;
    const appendedItems = displayedTimeline.filter((item) => {
      if (physicsKnownItemIdsRef.current.has(item.id)) {
        return false;
      }

      physicsKnownItemIdsRef.current.add(item.id);
      return true;
    });

    if (appendedItems.length === 0) {
      return;
    }

    const currentSnapshots = physicsSnapshotsRef.current ?? [];
    const nextTimeline = [...currentTimeline, ...appendedItems];
    const appendedSnapshots = appendedItems.map((item, index) => {
      const snapshotIndex = currentTimeline.length + index;

      return buildPhysicsPlaceholderSnapshot(
        snapshotIndex,
        physicsViewportSize.width,
        item.id,
      );
    });
    const nextSnapshots = [...currentSnapshots, ...appendedSnapshots];

    physicsWorldRef.current?.setBounds(
      physicsViewportSize.width,
      physicsViewportSize.height,
    );
    physicsWorldRef.current?.setBodies(
      nextSnapshots.map(snapshotToSeed),
    );
    setPhysicsTimelineSnapshot(nextTimeline);
    setPhysicsSnapshots(nextSnapshots);
    setPhysicsPendingMeasureIds((current) => [
      ...new Set([...current, ...appendedItems.map((item) => item.id)]),
    ]);
  }, [
    displayedTimeline,
    physicsViewportSize.height,
    physicsViewportSize.width,
    physicsWorldReady,
    props.physicsEnabled,
    props.timelineView,
  ]);

  useLayoutEffect(() => {
    if (
      !props.physicsEnabled
      || physicsViewportSize.width <= 0
      || physicsViewportSize.height <= 0
      || !physicsTimelineSnapshot
      || physicsTimelineSnapshot.length === 0
    ) {
      return;
    }

    if (physicsWorldReady && physicsPendingMeasureIds.length === 0) {
      return;
    }

    const measurementIds = physicsWorldReady
      ? physicsPendingMeasureIds
      : physicsTimelineSnapshot.map((item) => item.id);

    if (measurementIds.length === 0) {
      return;
    }

    const measuredById = new Map<
      string,
      {
        width: number;
        height: number;
        x: number;
        y: number;
      }
    >();

    for (const itemId of measurementIds) {
      const cardElement = physicsMeasureRefs.current[itemId];

      if (!cardElement) {
        return;
      }

      const rect = cardElement.getBoundingClientRect();
      measuredById.set(itemId, {
        width: rect.width,
        height: rect.height,
        x: rect.left,
        y: rect.top,
      });
    }

    let cancelled = false;

    if (!physicsWorldReady) {
      const visibleMeasuredItems = physicsTimelineSnapshot.filter((item) => {
        const measured = measuredById.get(item.id);

        return measured
          ? measured.y < physicsViewportSize.height
            && measured.y + measured.height > 0
          : true;
      });
      const nextTimeline = visibleMeasuredItems.length > 0
        ? visibleMeasuredItems
        : physicsTimelineSnapshot.slice(0, Math.min(8, physicsTimelineSnapshot.length));
      const initialStartY = nextTimeline.reduce((minimum, item) => {
        const measured = measuredById.get(item.id);

        if (!measured) {
          return minimum;
        }

        return Math.min(minimum, measured.y);
      }, Number.POSITIVE_INFINITY);
      const baseY = Number.isFinite(initialStartY)
        ? Math.max(PHYSICS_NEW_ITEM_SPAWN_Y_PX, initialStartY)
        : PHYSICS_NEW_ITEM_SPAWN_Y_PX;
      let compactY = baseY;
      const seeds = nextTimeline.map((item, index) => {
        const measured = measuredById.get(item.id);
        const width = measured?.width ?? buildPhysicsCardWidth(physicsViewportSize.width);
        const height = measured?.height ?? PHYSICS_CARD_FALLBACK_HEIGHT_PX;
        const seed = {
          x: measured?.x ?? PHYSICS_CARD_GUTTER_PX,
          y: compactY,
          width,
          height,
          angle: 0,
        };

        compactY += Math.max(96, height - PHYSICS_INITIAL_STACK_OVERLAP_PX);

        return seed;
      });

      void GravityWorld.create(
        physicsViewportSize.width,
        physicsViewportSize.height,
      ).then((world) => {
        if (cancelled) {
          return;
        }

        world.setBodies(seeds);
        physicsWorldRef.current = world;
        setPhysicsTimelineSnapshot(nextTimeline);
        setPhysicsSnapshots(seeds);
        setPhysicsWorldReady(true);
      });
    } else {
      const currentSnapshots = physicsSnapshotsRef.current ?? [];
      const nextSeeds = physicsTimelineSnapshot.map((item, index) => {
        const measured = measuredById.get(item.id);
        const base =
          currentSnapshots[index]
          ?? buildPhysicsPlaceholderSnapshot(index, physicsViewportSize.width, item.id);

        if (!measured) {
          return snapshotToSeed(base);
        }

        return {
          x: base.x,
          y: base.y,
          width: measured.width,
          height: measured.height,
          angle: base.angle,
        };
      });

      physicsWorldRef.current?.setBounds(
        physicsViewportSize.width,
        physicsViewportSize.height,
      );
      physicsWorldRef.current?.setBodies(nextSeeds);
      setPhysicsSnapshots(nextSeeds);
      setPhysicsPendingMeasureIds([]);
    }

    return () => {
      cancelled = true;
    };
  }, [
    physicsPendingMeasureIds,
    physicsTimelineSnapshot,
    physicsViewportSize.height,
    physicsViewportSize.width,
    physicsWorldReady,
    props.physicsEnabled,
  ]);

  useEffect(() => {
    if (
      !props.physicsEnabled
      || !physicsWorldReady
      || !physicsWorldRef.current
      || typeof window === "undefined"
    ) {
      return;
    }

    const tick = (frameAt: number) => {
      const world = physicsWorldRef.current;

      if (!world) {
        return;
      }

      const previousFrameAt = physicsLastFrameAtRef.current ?? frameAt;
      const dtMs = Math.min(frameAt - previousFrameAt, 33);
      physicsLastFrameAtRef.current = frameAt;
      setPhysicsSnapshots(world.step(dtMs));
      physicsFrameRef.current = window.requestAnimationFrame(tick);
    };

    physicsFrameRef.current = window.requestAnimationFrame(tick);

    return () => {
      if (physicsFrameRef.current !== null) {
        window.cancelAnimationFrame(physicsFrameRef.current);
        physicsFrameRef.current = null;
      }

      physicsLastFrameAtRef.current = null;
    };
  }, [physicsWorldReady, props.physicsEnabled]);

  useEffect(() => {
    if (
      !props.physicsEnabled
      || !physicsWorldReady
      || typeof window === "undefined"
    ) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (
        physicsDragPointerIdRef.current === null
        || physicsDragPointerIdRef.current !== event.pointerId
      ) {
        return;
      }

      if (!physicsWorldRef.current) {
        return;
      }

      physicsWorldRef.current.pointerMove(event.clientX, event.clientY);
      setPhysicsSnapshots(physicsWorldRef.current.step(0));
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (
        physicsDragPointerIdRef.current === null
        || physicsDragPointerIdRef.current !== event.pointerId
      ) {
        return;
      }

      physicsDragPointerIdRef.current = null;

      if (!physicsWorldRef.current) {
        return;
      }

      physicsWorldRef.current.pointerUp();
      setPhysicsSnapshots(physicsWorldRef.current.step(0));
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [physicsWorldReady, props.physicsEnabled]);

  useEffect(() => {
    if (
      !props.physicsEnabled
      || !physicsWorldReady
      || !physicsWorldRef.current
      || physicsViewportSize.width <= 0
      || physicsViewportSize.height <= 0
    ) {
      return;
    }

    physicsWorldRef.current.setBounds(
      physicsViewportSize.width,
      physicsViewportSize.height,
    );
  }, [
    physicsViewportSize.height,
    physicsViewportSize.width,
    physicsWorldReady,
    props.physicsEnabled,
  ]);

  function setPhysicsMeasureRef(itemId: string, element: HTMLLIElement | null) {
    physicsMeasureRefs.current[itemId] = element;
  }

  function handlePhysicsPointerDown(index: number, event: ReactPointerEvent<HTMLLIElement>) {
    if (!props.physicsEnabled || !physicsWorldRef.current) {
      return;
    }

    const accepted = physicsWorldRef.current.pointerDown(
      index,
      event.clientX,
      event.clientY,
    );

    if (!accepted) {
      return;
    }

    physicsDragPointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setPhysicsSnapshots(physicsWorldRef.current.step(0));
    event.preventDefault();
    event.stopPropagation();
  }

  function renderTimelineCard(
    item: TimelineItem,
    options: {
      itemRef?: (element: HTMLLIElement | null) => void;
      className?: string;
      onPointerDown?: (event: ReactPointerEvent<HTMLLIElement>) => void;
      physicsMode?: boolean;
      style?: CSSProperties;
    } = {},
  ) {
    const isReactionPending = props.pendingReactionEventIds.includes(item.id);
    const replyTargetPreviewItem = item.replyTargetEventId
      ? referenceById.get(item.replyTargetEventId) ?? null
      : null;
    const replyTargetPreviewStatus = item.replyTargetEventId
      ? props.replyPreviewStatuses[item.replyTargetEventId] ?? null
      : null;

    return (
      <TimelineCard
        key={item.id}
        canSendReaction={props.canSendReaction}
        className={options.className}
        developerModeEnabled={props.developerModeEnabled}
        isProfileImageEnabled={props.isProfileImageEnabled}
        isPublishing={props.isPublishing}
        isReactionPending={isReactionPending}
        item={item}
        itemRef={options.itemRef}
        onCopyEventId={props.onCopyEventId}
        onPauseTimelineDisplay={pauseTimelineDisplay}
        onPointerDown={options.onPointerDown}
        onReact={props.onReact}
        onResumeTimelineDisplay={resumeTimelineDisplay}
        onViewEventJson={props.onViewEventJson}
        physicsMode={options.physicsMode}
        readyWriteRelayCount={props.readyWriteRelayCount}
        replyTargetPreviewItem={replyTargetPreviewItem}
        replyTargetPreviewStatus={replyTargetPreviewStatus}
        style={options.style}
        timelineView={props.timelineView}
      />
    );
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <h2 className="section-chip timeline-heading-chip">{props.timelineHeadingLabel}</h2>
        <div className="view-switcher" role="group" aria-label="タイムライン切替">
          <button
            type="button"
            className={`view-button${activeTimelineView === "relay" ? " view-button-active" : ""}`}
            onClick={() => {
              void props.onTimelineViewChange("relay");
            }}
            title={props.relayButtonTitle}
          >
            Relay
          </button>
          <button
            type="button"
            className={`view-button${activeTimelineView === "follow" ? " view-button-active" : ""}`}
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
              className={`view-button${activeTimelineView === "account" ? " view-button-active" : ""}`}
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
              className={`view-button${activeTimelineView === "notify" ? " view-button-active" : ""}`}
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
              className={`view-button${activeTimelineView === "reaction" ? " view-button-active" : ""}`}
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

      {visibleCards.length === 0 ? (
        <p className="muted">{props.emptyMessage}</p>
      ) : props.physicsEnabled ? (
        <>
          {!physicsWorldReady ? (
            <ul className="list timeline-physics-measure-list">
              {visibleCards.map((item) =>
                renderTimelineCard(item, {
                  className: "timeline-physics-measure-card",
                  itemRef: (element) => {
                    setPhysicsMeasureRef(item.id, element);
                  },
                  physicsMode: true,
                }),
              )}
            </ul>
          ) : (
            <p className="muted timeline-physics-placeholder">
              物理演算中...
            </p>
          )}

          {physicsPendingItems.length > 0 ? (
            <ul className="list timeline-physics-hidden-measure">
              {physicsPendingItems.map((item) =>
                renderTimelineCard(item, {
                  className: "timeline-physics-measure-card",
                  itemRef: (element) => {
                    setPhysicsMeasureRef(item.id, element);
                  },
                  physicsMode: true,
                }),
              )}
            </ul>
          ) : null}

          {physicsWorldReady && physicsSnapshots !== null && physicsTimelineSnapshot ? (
            <div
              ref={physicsStageRef}
              className="timeline-physics-stage timeline-physics-stage-active"
            >
              {physicsTimelineSnapshot.map((item, index) => {
                const snapshot = physicsSnapshots[index];

                if (!snapshot) {
                  return null;
                }

                return renderTimelineCard(item, {
                  className: "timeline-physics-card",
                  onPointerDown: (event) => {
                    handlePhysicsPointerDown(index, event);
                  },
                  physicsMode: true,
                  style: {
                    inlineSize: `${snapshot.width}px`,
                    transform: `translate(${snapshot.x}px, ${snapshot.y}px) rotate(${snapshot.angle}rad)`,
                  },
                });
              })}
            </div>
          ) : null}
        </>
      ) : (
        <ul className="list">
          {visibleCards.map((item) => renderTimelineCard(item))}
        </ul>
      )}
    </section>
  );
}

function buildPhysicsCardWidth(viewportWidth: number) {
  return Math.min(PHYSICS_CARD_INLINE_SIZE_PX, Math.max(220, viewportWidth - 32));
}

function buildPhysicsPlaceholderSnapshot(
  index: number,
  viewportWidth: number,
  itemId: string,
): GravityBodySnapshot {
  const width = buildPhysicsCardWidth(viewportWidth);
  const lane = index % 3;
  const centeredX = (viewportWidth - width) / 2;
  const x = Math.max(
    PHYSICS_CARD_GUTTER_PX,
    Math.min(
      viewportWidth - width - PHYSICS_CARD_GUTTER_PX,
      centeredX + (lane - 1) * 24,
    ),
  );

  return {
    x,
    y: -PHYSICS_CARD_FALLBACK_HEIGHT_PX - (index % 3) * 18,
    width,
    height: PHYSICS_CARD_FALLBACK_HEIGHT_PX,
    angle: hashPhysicsAngle(itemId),
  };
}

function hashPhysicsAngle(itemId: string) {
  let hash = 0;

  for (let index = 0; index < itemId.length; index += 1) {
    hash = (hash * 33 + itemId.charCodeAt(index)) % 997;
  }

  return ((hash % 21) - 10) * 0.01;
}

function snapshotToSeed(snapshot: GravityBodySnapshot): GravityBodySeed {
  return {
    x: snapshot.x,
    y: snapshot.y,
    width: snapshot.width,
    height: snapshot.height,
    angle: snapshot.angle,
  };
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
