import React, { useCallback, useEffect, useRef, useState } from "react";

/** Pointer travel before a press turns into a drag (below it, clicks and double-clicks work as usual) */
const DRAG_THRESHOLD_PX = 6;
/** The ghost sits this far below / right of the cursor */
export const GHOST_OFFSET_PX = 14;

/** What a drop board tile stands for: a list status, a custom list to add to, or the custom list to leave */
export type DropTarget =
  | { kind: "status"; status: string }
  | { kind: "list"; name: string }
  | { kind: "unlist"; name: string };

/** The tile's `data-drop` value (also what `hoverTarget` holds while the pointer is over it) */
export const dropKey = (t: DropTarget) => `${t.kind}:${t.kind === "status" ? t.status : t.name}`;

function parseDropKey(key: string): DropTarget | null {
  const at = key.indexOf(":");
  const kind = key.slice(0, at);
  const value = key.slice(at + 1);
  if (kind === "status") return { kind, status: value };
  if (kind === "list" || kind === "unlist") return { kind, name: value };
  return null;
}

/** A drag in progress: the anime being moved and the area the drop board covers */
export interface StatusDragState {
  ids: number[];
  /** `<main>`'s rect when the drag started (the board centers over it; the sidebar stays bright) */
  area: { top: number; left: number; width: number; height: number };
}

interface Options {
  selectedAnimeIds: number[];
  onSetSelectedAnimeIds: (ids: number[]) => void;
  lastClickedIdRef: React.MutableRefObject<number | null>;
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  /** Dropped on a tile */
  onDrop: (ids: number[], target: DropTarget) => void;
}

/**
 * Drag cards / rows onto the drop board (statuses, custom lists). Pointer events, not HTML5 drag and drop (WebView2
 * doesn't deliver HTML5 drag events while Tauri's native file drop is on). After the press every
 * listener is on `window`: a virtualized card can unmount while the pointer is away from it.
 */
export function useStatusDrag(options: Options) {
  const opts = useRef(options);
  opts.current = options;

  const [drag, setDrag] = useState<StatusDragState | null>(null);
  const [hoverTarget, setHoverTarget] = useState<string | null>(null);
  const hoverRef = useRef<string | null>(null);
  const ghostEl = useRef<HTMLElement | null>(null);
  const pos = useRef({ x: 0, y: 0 });
  const cleanupRef = useRef<(() => void) | null>(null);

  const placeGhost = () => {
    const el = ghostEl.current;
    if (el) {
      el.style.transform = `translate3d(${pos.current.x + GHOST_OFFSET_PX}px, ${pos.current.y + GHOST_OFFSET_PX}px, 0)`;
    }
  };

  /** Callback ref for the ghost: placed as soon as it mounts, then moved without React renders */
  const ghostRef = useCallback((el: HTMLElement | null) => {
    ghostEl.current = el;
    placeGhost();
  }, []);

  // Unmounting mid-drag (tab switch, view mode change) never leaves window listeners behind
  useEffect(() => () => cleanupRef.current?.(), []);

  const startPress = useCallback((e: React.PointerEvent, animeId: number) => {
    if (e.button !== 0 || cleanupRef.current) return;
    // Controls inside a card (step buttons, links, inputs) keep their own behavior
    if ((e.target as HTMLElement).closest("button, a, input, textarea, select, [data-no-drag]")) return;

    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;
    let draggedIds: number[] = [];
    let frame = 0;

    const hitTest = () => {
      frame = 0;
      const target = document
        .elementFromPoint(pos.current.x, pos.current.y)
        ?.closest<HTMLElement>("[data-drop]");
      const key = target && target.dataset.dropDisabled !== "true" ? target.dataset.drop ?? null : null;
      if (key !== hoverRef.current) {
        hoverRef.current = key;
        setHoverTarget(key);
      }
    };

    const begin = () => {
      started = true;
      const { selectedAnimeIds, onSetSelectedAnimeIds, lastClickedIdRef, scrollContainerRef } = opts.current;
      // A selected card drags the whole selection; any other card becomes the selection
      let ids = selectedAnimeIds;
      if (!selectedAnimeIds.includes(animeId)) {
        ids = [animeId];
        onSetSelectedAnimeIds(ids);
        lastClickedIdRef.current = animeId;
      }
      draggedIds = ids;
      const rect = (scrollContainerRef.current ?? document.body).getBoundingClientRect();
      window.getSelection()?.removeAllRanges();
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      setDrag({
        ids,
        area: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      });
    };

    const onMove = (ev: PointerEvent) => {
      pos.current = { x: ev.clientX, y: ev.clientY };
      if (!started) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
        begin();
      }
      placeGhost();
      if (!frame) frame = requestAnimationFrame(hitTest);
    };

    const finish = (drop: boolean) => {
      const key = hoverRef.current;
      const wasStarted = started;
      cleanup();
      if (!wasStarted) return;
      // The click that follows the release must not reselect the card under the pointer
      const swallow = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      const target = drop && key ? parseDropKey(key) : null;
      if (target) opts.current.onDrop(draggedIds, target);
    };

    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    // Capture phase: Esc cancels the drag only, it doesn't also clear the selection
    const onKey = (ev: KeyboardEvent) => {
      if (!started || ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      window.removeEventListener("keydown", onKey, true);
      if (frame) cancelAnimationFrame(frame);
      if (started) {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
      hoverRef.current = null;
      setHoverTarget(null);
      setDrag(null);
      cleanupRef.current = null;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
    window.addEventListener("keydown", onKey, true);
    cleanupRef.current = cleanup;
  }, []);

  return { drag, hoverTarget, ghostRef, startPress };
}
