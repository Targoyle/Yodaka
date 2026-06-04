import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { AuxiliaryTimelineDiagnostic, TimelineView } from "../app/types";
import type { ReactionIntent } from "../lib/nostr/reaction";
import { formatRecordedAt } from "../lib/ui/formatters";
import type { TimelineItem } from "../lib/wasm/client";
import type {
  GravityBodySeed,
  GravityBodySnapshot,
  GravityWorld,
} from "../lib/wasm/gravity";
import { TimelineCard } from "./TimelineCard";

const PHYSICS_CARD_GUTTER_PX = 16;
const PHYSICS_CARD_INLINE_SIZE_PX = 360;
const PHYSICS_CARD_FALLBACK_HEIGHT_PX = 180;
const PHYSICS_DEBUG_PANEL_GUTTER_PX = 12;
const PHYSICS_FLOOR_MARGIN_PX = 2;
const PHYSICS_INITIAL_STACK_OVERLAP_PX = 56;
const PHYSICS_MAX_ACTIVE_BODIES = 6;
const PHYSICS_ROTATION_ENABLED = false;
const PHYSICS_SPAWN_X_JITTER_PX = 96;
const PHYSICS_TOP_SPAWN_PADDING_PX = 40;
const PHYSICS_TOP_SPAWN_STEP_PX = 18;

type TimelinePanelProps = {
  accountTabEnabled: boolean;
  canOpenPersonalTimeline: boolean;
  canReply: boolean;
  canSendReaction: boolean;
  developerModeEnabled: boolean;
  emptyMessage: string;
  focusedEventMode: boolean;
  isProfileImageEnabled: boolean;
  isPublishing: boolean;
  notifyTabEnabled: boolean;
  onCopyEventId: (eventId: string) => void | Promise<void>;
  onReply: (item: TimelineItem) => void | Promise<void>;
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

type PanelPosition = {
  x: number;
  y: number;
};

type PhysicsDebugDragState = {
  pointerId: number;
  offsetX: number;
  offsetY: number;
};

type PhysicsSpawnBlockedRange = {
  start: number;
  end: number;
};

type GravityModule = typeof import("../lib/wasm/gravity");

let gravityModulePromise: Promise<GravityModule> | null = null;

function loadGravityModule() {
  if (!gravityModulePromise) {
    gravityModulePromise = import("../lib/wasm/gravity");
  }

  return gravityModulePromise;
}

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
  const [physicsDebugPanelPosition, setPhysicsDebugPanelPosition] = useState<PanelPosition>({
    x: PHYSICS_DEBUG_PANEL_GUTTER_PX,
    y: PHYSICS_DEBUG_PANEL_GUTTER_PX,
  });
  const [isPhysicsDebugPanelDragging, setIsPhysicsDebugPanelDragging] = useState(false);
  const visibleTimelineRef = useRef<TimelineItem[]>(props.visibleTimeline);
  const hoveredReactionButtonCountRef = useRef(0);
  const reactionPauseReleaseTimerRef = useRef<number | null>(null);
  const physicsDebugDragRef = useRef<PhysicsDebugDragState | null>(null);
  const physicsDebugPanelRef = useRef<HTMLElement | null>(null);
  const timelinePanelRef = useRef<HTMLElement | null>(null);
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
    if (!props.physicsEnabled) {
      return;
    }

    void loadGravityModule();
  }, [props.physicsEnabled]);

  useEffect(() => {
    if (!props.physicsEnabled || typeof window === "undefined") {
      return;
    }

    const html = document.documentElement;
    const body = document.body;
    const previousHtmlOverflow = html.style.overflow;
    const previousBodyOverflow = body.style.overflow;

    html.style.overflow = "hidden";
    body.style.overflow = "hidden";

    return () => {
      html.style.overflow = previousHtmlOverflow;
      body.style.overflow = previousBodyOverflow;
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

  const physicsBodyDebugRows = useMemo(() => {
    if (!physicsTimelineSnapshot || !physicsSnapshots) {
      return [];
    }

    return physicsTimelineSnapshot.map((item, index) => {
      const snapshot = physicsSnapshots[index];

      if (!snapshot) {
        return `${index}. ${formatPhysicsDebugId(item.id)} missing`;
      }

      return `${index}. x:${formatPhysicsDebugNumber(snapshot.x)} y:${formatPhysicsDebugNumber(snapshot.y)} w:${formatPhysicsDebugNumber(snapshot.width)} h:${formatPhysicsDebugNumber(snapshot.height)} id:${formatPhysicsDebugId(item.id)}`;
    });
  }, [physicsSnapshots, physicsTimelineSnapshot]);

  const physicsViewportDebugRows = useMemo(() => {
    if (typeof window === "undefined") {
      return [];
    }

    const rows = [
      `inner ${Math.round(physicsViewportSize.width)}x${Math.round(physicsViewportSize.height)}`,
      `screen ${Math.round(window.screen.width)}x${Math.round(window.screen.height)}`,
      `dpr ${window.devicePixelRatio.toFixed(2)}`,
    ];

    if (window.visualViewport) {
      rows.push(
        `visual ${Math.round(window.visualViewport.width)}x${Math.round(window.visualViewport.height)} @ ${Math.round(window.visualViewport.offsetLeft)},${Math.round(window.visualViewport.offsetTop)}`,
      );
    }

    return rows;
  }, [physicsViewportSize.height, physicsViewportSize.width]);

  const displayedCardDebugRows = useMemo(
    () => displayedTimeline.map((item, index) => `${index}. ${formatPhysicsDebugId(item.id)}`),
    [displayedTimeline],
  );

  const physicsPendingItems = useMemo(() => {
    if (!physicsTimelineSnapshot || physicsPendingMeasureIds.length === 0) {
      return [];
    }

    const pendingIdSet = new Set(physicsPendingMeasureIds);
    return physicsTimelineSnapshot.filter((item) => pendingIdSet.has(item.id));
  }, [physicsPendingMeasureIds, physicsTimelineSnapshot]);

  useLayoutEffect(() => {
    if (!props.physicsEnabled) {
      return;
    }

    setPhysicsDebugPanelPosition((current) => {
      const next = clampPhysicsDebugPanelPosition(current);

      return current.x === next.x && current.y === next.y ? current : next;
    });
  }, [
    displayedCardDebugRows.length,
    physicsBodyDebugRows.length,
    physicsViewportSize.height,
    physicsViewportDebugRows.length,
    physicsViewportSize.width,
    props.physicsEnabled,
  ]);

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
      physicsDebugDragRef.current = null;
      setIsPhysicsDebugPanelDragging(false);
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
      physicsKnownItemIdsRef.current = new Set();
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
      || !physicsWorldRef.current
      || physicsSourceViewRef.current !== props.timelineView
    ) {
      return;
    }

    const displayedIdSet = new Set(displayedTimeline.map((item) => item.id));
    const currentTimeline = physicsTimelineSnapshotRef.current;
    const currentSnapshots = physicsSnapshotsRef.current ?? [];
    const snapshotIndexById = new Map(
      currentTimeline.map((item, index) => [item.id, index]),
    );
    const retainedTimeline = currentTimeline.filter((item) => displayedIdSet.has(item.id));
    const retainedSnapshots = retainedTimeline
      .map((item) => {
        const snapshotIndex = snapshotIndexById.get(item.id) ?? -1;

        return snapshotIndex >= 0 ? currentSnapshots[snapshotIndex] ?? null : null;
      })
      .filter((snapshot): snapshot is GravityBodySnapshot => snapshot !== null);

    if (retainedTimeline.length !== currentTimeline.length) {
      physicsWorldRef.current.setBounds(
        physicsViewportSize.width,
        physicsViewportSize.height,
      );
      physicsWorldRef.current.setBodies(retainedSnapshots.map(snapshotToSeed));
      physicsKnownItemIdsRef.current = new Set(
        [...physicsKnownItemIdsRef.current].filter((itemId) => displayedIdSet.has(itemId)),
      );
      setPhysicsTimelineSnapshot(retainedTimeline);
      setPhysicsSnapshots(retainedSnapshots);
      setPhysicsPendingMeasureIds((current) =>
        current.filter((itemId) => displayedIdSet.has(itemId)),
      );
      return;
    }

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

    const appendedTimeline = [...currentTimeline, ...appendedItems];
    const overflowCount = Math.max(0, appendedTimeline.length - PHYSICS_MAX_ACTIVE_BODIES);
    const nextTimeline = overflowCount > 0
      ? appendedTimeline.slice(overflowCount)
      : appendedTimeline;
    const nextTimelineIdSet = new Set(nextTimeline.map((item) => item.id));

    if (overflowCount > 0) {
      const nextSnapshots = currentTimeline
        .map((item, index) => ({
          item,
          snapshot: currentSnapshots[index] ?? null,
        }))
        .filter(({ item }) => nextTimelineIdSet.has(item.id))
        .map(({ snapshot }) => snapshot)
        .filter((snapshot): snapshot is GravityBodySnapshot => snapshot !== null);

      physicsWorldRef.current.setBounds(
        physicsViewportSize.width,
        physicsViewportSize.height,
      );
      physicsWorldRef.current.setBodies(nextSnapshots.map(snapshotToSeed));
      setPhysicsSnapshots(nextSnapshots);
    }

    setPhysicsTimelineSnapshot(nextTimeline);
    setPhysicsPendingMeasureIds((current) => [
      ...new Set([
        ...current.filter((itemId) => nextTimelineIdSet.has(itemId)),
        ...appendedItems
          .map((item) => item.id)
          .filter((itemId) => nextTimelineIdSet.has(itemId)),
      ]),
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
    const timelinePanelRect = timelinePanelRef.current?.getBoundingClientRect();
    const spawnBlockedRange = timelinePanelRect
      ? {
        start: timelinePanelRect.left,
        end: timelinePanelRect.right,
      }
      : null;

    if (!physicsWorldReady) {
      const visibleMeasuredItems = physicsTimelineSnapshot.filter((item) => {
        const measured = measuredById.get(item.id);

        return measured
          ? measured.y < physicsViewportSize.height
            && measured.y + measured.height > 0
          : true;
      });
      const nextTimelineSource = visibleMeasuredItems.length > 0
        ? visibleMeasuredItems
        : physicsTimelineSnapshot;
      const nextTimeline = nextTimelineSource.slice(
        0,
        Math.min(PHYSICS_MAX_ACTIVE_BODIES, nextTimelineSource.length),
      );
      const seeds = nextTimeline.map((item, index) => {
        const measured = measuredById.get(item.id);
        const width = measured?.width ?? buildPhysicsCardWidth(physicsViewportSize.width);
        const height = measured?.height ?? PHYSICS_CARD_FALLBACK_HEIGHT_PX;
        const seed = {
          x: buildPhysicsSpawnX(physicsViewportSize.width, width, item.id, spawnBlockedRange),
          y: buildPhysicsSpawnY(index, height),
          width,
          height,
          angle: buildPhysicsAngle(item.id),
        };

        return seed;
      });

      void loadGravityModule()
        .then(({ GravityWorld }) =>
          GravityWorld.create(
            physicsViewportSize.width,
            physicsViewportSize.height,
          ),
        )
        .then((world) => {
          if (cancelled) {
            return;
          }

          world.setBodies(seeds);
          physicsKnownItemIdsRef.current = new Set(displayedTimeline.map((item) => item.id));
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
          ?? buildPhysicsPlaceholderSnapshot(
            index,
            physicsViewportSize.width,
            item.id,
            spawnBlockedRange,
          );

        if (!measured) {
          return snapshotToSeed(base);
        }

        return {
          x: base.x,
          y: base.y,
          width: measured.width,
          height: measured.height,
          angle: PHYSICS_ROTATION_ENABLED ? base.angle : 0,
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

  function clampPhysicsDebugPanelPosition(position: PanelPosition): PanelPosition {
    if (typeof window === "undefined") {
      return position;
    }

    const panelRect = physicsDebugPanelRef.current?.getBoundingClientRect();
    const panelWidth = panelRect?.width ?? 0;
    const panelHeight = panelRect?.height ?? 0;
    const maxX = Math.max(
      PHYSICS_DEBUG_PANEL_GUTTER_PX,
      window.innerWidth - panelWidth - PHYSICS_DEBUG_PANEL_GUTTER_PX,
    );
    const maxY = Math.max(
      PHYSICS_DEBUG_PANEL_GUTTER_PX,
      window.innerHeight - panelHeight - PHYSICS_DEBUG_PANEL_GUTTER_PX,
    );

    return {
      x: Math.round(Math.min(Math.max(PHYSICS_DEBUG_PANEL_GUTTER_PX, position.x), maxX)),
      y: Math.round(Math.min(Math.max(PHYSICS_DEBUG_PANEL_GUTTER_PX, position.y), maxY)),
    };
  }

  function handlePhysicsDebugPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }

    const panelRect = physicsDebugPanelRef.current?.getBoundingClientRect();

    if (!panelRect) {
      return;
    }

    physicsDebugDragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - panelRect.left,
      offsetY: event.clientY - panelRect.top,
    };
    setIsPhysicsDebugPanelDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  function handlePhysicsDebugPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = physicsDebugDragRef.current;

    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    setPhysicsDebugPanelPosition((current) => {
      const next = clampPhysicsDebugPanelPosition({
        x: event.clientX - drag.offsetX,
        y: event.clientY - drag.offsetY,
      });

      return current.x === next.x && current.y === next.y ? current : next;
    });
    event.preventDefault();
  }

  function handlePhysicsDebugPointerRelease(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = physicsDebugDragRef.current;

    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    physicsDebugDragRef.current = null;
    setIsPhysicsDebugPanelDragging(false);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
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
    return (
      <TimelineCard
        key={item.id}
        canReply={props.canReply}
        canSendReaction={props.canSendReaction}
        className={options.className}
        developerModeEnabled={props.developerModeEnabled}
        isProfileImageEnabled={props.isProfileImageEnabled}
        isPublishing={props.isPublishing}
        item={item}
        itemRef={options.itemRef}
        onCopyEventId={props.onCopyEventId}
        onPauseTimelineDisplay={pauseTimelineDisplay}
        onPointerDown={options.onPointerDown}
        onReply={props.onReply}
        onReact={props.onReact}
        onResumeTimelineDisplay={resumeTimelineDisplay}
        onViewEventJson={props.onViewEventJson}
        pendingReactionEventIds={props.pendingReactionEventIds}
        physicsMode={options.physicsMode}
        readyWriteRelayCount={props.readyWriteRelayCount}
        referenceItemsById={referenceById}
        replyPreviewStatuses={props.replyPreviewStatuses}
        style={options.style}
        timelineView={props.timelineView}
      />
    );
  }

  const physicsStage =
    physicsWorldReady
    && physicsSnapshots !== null
    && physicsTimelineSnapshot
    && typeof document !== "undefined"
      ? createPortal(
        <div
          ref={physicsStageRef}
          className="timeline-physics-stage timeline-physics-stage-active"
        >
          <div
            aria-hidden="true"
            className="timeline-physics-floor-debug"
            style={{
              insetBlockEnd: `${PHYSICS_FLOOR_MARGIN_PX}px`,
            }}
          />
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
                blockSize: `${snapshot.height}px`,
                inlineSize: `${snapshot.width}px`,
                transform: PHYSICS_ROTATION_ENABLED
                  ? `translate(${snapshot.x}px, ${snapshot.y}px) rotate(${snapshot.angle}rad)`
                  : `translate(${snapshot.x}px, ${snapshot.y}px)`,
              },
            });
          })}
        </div>,
        document.body,
      )
      : null;

  const physicsDebugOverlay =
    props.physicsEnabled
    && typeof document !== "undefined"
      ? createPortal(
        <aside
          ref={physicsDebugPanelRef}
          className={`timeline-physics-debug-panel${isPhysicsDebugPanelDragging ? " timeline-physics-debug-panel-dragging" : ""}`}
          aria-live="polite"
          style={{
            insetBlockStart: `${physicsDebugPanelPosition.y}px`,
            insetInlineStart: `${physicsDebugPanelPosition.x}px`,
          }}
        >
          <div
            className="timeline-physics-debug-handle"
            onPointerDown={handlePhysicsDebugPointerDown}
            onPointerMove={handlePhysicsDebugPointerMove}
            onPointerUp={handlePhysicsDebugPointerRelease}
            onPointerCancel={handlePhysicsDebugPointerRelease}
          >
            <p className="timeline-physics-debug-title">Physics Debug</p>
            <span className="timeline-physics-debug-handle-note" aria-hidden="true">drag</span>
          </div>
          <p className="timeline-physics-debug-summary">
            {`world ${physicsWorldReady ? "ready" : "pending"} / rotation ${PHYSICS_ROTATION_ENABLED ? "on" : "off"} / bodies ${physicsSnapshots?.length ?? 0} / cards ${physicsTimelineSnapshot?.length ?? 0} / displayed ${displayedTimeline.length}`}
          </p>
          <div className="timeline-physics-debug-section">
            <p className="timeline-physics-debug-heading">Viewport</p>
            {physicsViewportDebugRows.length > 0 ? (
              <ul className="timeline-physics-debug-list">
                {physicsViewportDebugRows.map((row) => (
                  <li key={row}>{row}</li>
                ))}
              </ul>
            ) : (
              <p className="timeline-physics-debug-empty">No viewport</p>
            )}
          </div>
          <div className="timeline-physics-debug-section">
            <p className="timeline-physics-debug-heading">Bodies</p>
            {physicsBodyDebugRows.length > 0 ? (
              <ul className="timeline-physics-debug-list">
                {physicsBodyDebugRows.map((row) => (
                  <li key={row}>{row}</li>
                ))}
              </ul>
            ) : (
              <p className="timeline-physics-debug-empty">No bodies</p>
            )}
          </div>
          <div className="timeline-physics-debug-section">
            <p className="timeline-physics-debug-heading">Displayed</p>
            {displayedCardDebugRows.length > 0 ? (
              <ul className="timeline-physics-debug-list">
                {displayedCardDebugRows.map((row) => (
                  <li key={row}>{row}</li>
                ))}
              </ul>
            ) : (
              <p className="timeline-physics-debug-empty">No cards</p>
            )}
          </div>
        </aside>,
        document.body,
      )
      : null;

  return (
    <section ref={timelinePanelRef} className="panel">
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

          {physicsStage}
          {physicsDebugOverlay}
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
  blockedRange: PhysicsSpawnBlockedRange | null,
): GravityBodySnapshot {
  const width = buildPhysicsCardWidth(viewportWidth);
  const x = buildPhysicsSpawnX(viewportWidth, width, itemId, blockedRange);

  return {
    x,
    y: buildPhysicsSpawnY(index, PHYSICS_CARD_FALLBACK_HEIGHT_PX),
    width,
    height: PHYSICS_CARD_FALLBACK_HEIGHT_PX,
    angle: buildPhysicsAngle(itemId),
  };
}

function buildPhysicsSpawnX(
  viewportWidth: number,
  width: number,
  itemId: string,
  blockedRange: PhysicsSpawnBlockedRange | null = null,
) {
  const minX = PHYSICS_CARD_GUTTER_PX;
  const maxX = Math.max(minX, viewportWidth - width - PHYSICS_CARD_GUTTER_PX);
  const intervals = buildPhysicsSpawnIntervals(minX, maxX, width, blockedRange);
  const totalSpan = intervals.reduce((sum, interval) => sum + interval.span, 0);

  if (intervals.length === 0 || totalSpan <= 0) {
    return minX;
  }

  const laneSeed = hashPhysicsSeed(`${itemId}:lane`) / 997;
  let spanOffset = totalSpan * laneSeed;
  let selectedInterval = intervals[intervals.length - 1];

  for (const interval of intervals) {
    if (spanOffset <= interval.span) {
      selectedInterval = interval;
      break;
    }

    spanOffset -= interval.span;
  }

  const laneBaseX = selectedInterval.start + Math.min(spanOffset, selectedInterval.span);
  const jitterSeed = hashPhysicsSeed(`${itemId}:spawn`);
  const jitterRange = Math.min(PHYSICS_SPAWN_X_JITTER_PX, selectedInterval.span * 0.2);
  const jitter = intervals.length > 1 || selectedInterval.span > 0
    ? ((jitterSeed % 11) - 5) * (jitterRange / 5)
    : 0;

  return Math.max(
    selectedInterval.start,
    Math.min(selectedInterval.end, laneBaseX + jitter),
  );
}

function buildPhysicsSpawnIntervals(
  minX: number,
  maxX: number,
  width: number,
  blockedRange: PhysicsSpawnBlockedRange | null,
) {
  if (!blockedRange) {
    return [{ start: minX, end: maxX, span: Math.max(0, maxX - minX) }];
  }

  const leftEnd = Math.min(
    maxX,
    blockedRange.start - width - PHYSICS_CARD_GUTTER_PX,
  );
  const rightStart = Math.max(
    minX,
    blockedRange.end + PHYSICS_CARD_GUTTER_PX,
  );
  const intervals: Array<{ start: number; end: number; span: number }> = [];

  if (leftEnd >= minX) {
    intervals.push({
      start: minX,
      end: leftEnd,
      span: Math.max(0, leftEnd - minX),
    });
  }

  if (maxX >= rightStart) {
    intervals.push({
      start: rightStart,
      end: maxX,
      span: Math.max(0, maxX - rightStart),
    });
  }

  return intervals.length > 0
    ? intervals
    : [{ start: minX, end: maxX, span: Math.max(0, maxX - minX) }];
}

function buildPhysicsSpawnY(index: number, height: number) {
  const compactOffset = Math.min(
    index * PHYSICS_TOP_SPAWN_STEP_PX,
    Math.max(0, height - PHYSICS_INITIAL_STACK_OVERLAP_PX),
  );

  return -height - PHYSICS_TOP_SPAWN_PADDING_PX - compactOffset;
}

function buildPhysicsAngle(itemId: string) {
  return PHYSICS_ROTATION_ENABLED ? hashPhysicsAngle(itemId) : 0;
}

function hashPhysicsAngle(itemId: string) {
  const hash = hashPhysicsSeed(itemId);
  return ((hash % 21) - 10) * 0.01;
}

function hashPhysicsSeed(itemId: string) {
  let hash = 0;

  for (let index = 0; index < itemId.length; index += 1) {
    hash = (hash * 33 + itemId.charCodeAt(index)) % 997;
  }

  return hash;
}

function formatPhysicsDebugId(itemId: string) {
  return itemId.length <= 12 ? itemId : `${itemId.slice(0, 12)}...`;
}

function formatPhysicsDebugNumber(value: number) {
  return Math.round(value).toString();
}

function snapshotToSeed(snapshot: GravityBodySnapshot): GravityBodySeed {
  return {
    x: snapshot.x,
    y: snapshot.y,
    width: snapshot.width,
    height: snapshot.height,
    angle: PHYSICS_ROTATION_ENABLED ? snapshot.angle : 0,
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
