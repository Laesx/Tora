import { RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { log } from "@/lib/log";

/** One row of a virtualized list, in list coordinates (0 = the list's top edge) */
export interface VirtualRow {
  top: number;
  height: number;
}

/**
 * Indices `[start, end)` of the rows overlapping `[from, to)`. Rows must be sorted by `top` and not
 * overlap; the first row is found by binary search, so the cost is the number of visible rows.
 */
export function visibleRange(rows: readonly VirtualRow[], from: number, to: number): [number, number] {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].top + rows[mid].height <= from) lo = mid + 1;
    else hi = mid;
  }
  let end = lo;
  while (end < rows.length && rows[end].top < to) end++;
  return [lo, end];
}

export interface ScrollViewport {
  /** The list element's width */
  width: number;
  /** The list's top edge within the scroll container's content */
  top: number;
  scrollTop: number;
  viewportHeight: number;
}

const FALLBACK: ScrollViewport = { width: 1080, top: 0, scrollTop: 0, viewportHeight: 800 };
/** More viewport changes than this before the next frame is a feedback loop, not scrolling */
const MAX_CHANGES_PER_FRAME = 8;

/**
 * Measures a virtualized list that scrolls inside `scrollRef` (e.g. `<main>`). Re-measured after
 * every render (content above the list can move it without resizing it; unchanged values bail
 * out), when either element resizes, and on scroll (rAF-throttled).
 *
 * Give the list element `[overflow-anchor:none]`: Chromium's scroll anchoring would otherwise move
 * `scrollTop` whenever the spacers change, and that scroll re-renders the window again (a loop).
 * Every row must also be exactly the height the row model says (no wrapping, no borders).
 */
export function useScrollViewport(
  listRef: RefObject<HTMLElement | null>,
  scrollRef: RefObject<HTMLElement | null>
): ScrollViewport {
  const [viewport, setViewport] = useState(FALLBACK);
  // Last value handed to React, and how many changes this frame (see `MAX_CHANGES_PER_FRAME`)
  const lastRef = useRef(FALLBACK);
  const burstRef = useRef({ changes: 0, resetFrame: 0, deferredFrame: 0, warned: false });
  // Unrounded `scrollTop` at the last measure; `subpixelWarned` once a re-render moved it by < 1 px
  const rawScrollTopRef = useRef(0);
  const subpixelWarnedRef = useRef(false);

  /** `afterRender`: called from the layout effect (not a scroll or resize) */
  const measure = useCallback((afterRender = false) => {
    const listEl = listRef.current;
    const scrollEl = scrollRef.current;
    if (!listEl || !scrollEl) return;
    const rawScrollTop = scrollEl.scrollTop;
    const moved = rawScrollTop - rawScrollTopRef.current;
    rawScrollTopRef.current = rawScrollTop;
    // Diagnostic: a render that shifts the scroll offset by a fraction of a pixel (display scaling)
    // used to feed a measure → render loop ("Maximum update depth exceeded"); rounding absorbs it
    if (afterRender && moved !== 0 && Math.abs(moved) < 1 && !subpixelWarnedRef.current) {
      subpixelWarnedRef.current = true;
      log.warn("virtual", `a re-render moved scrollTop by ${moved} px (${rawScrollTop - moved} → ${rawScrollTop})`);
    }
    const next: ScrollViewport = {
      width: listEl.clientWidth || FALLBACK.width,
      top: Math.round(listEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop),
      // Fractional at display scaling; a sub-pixel difference never changes the rendered window
      scrollTop: Math.round(scrollEl.scrollTop),
      viewportHeight: scrollEl.clientHeight || FALLBACK.viewportHeight,
    };
    const prev = lastRef.current;
    if (
      prev.width === next.width &&
      prev.top === next.top &&
      prev.scrollTop === next.scrollTop &&
      prev.viewportHeight === next.viewportHeight
    ) {
      return;
    }
    const burst = burstRef.current;
    // Re-rendering moved what it measures again (a layout feedback loop): measure next frame
    // instead, so the loop can't freeze or crash the page, and say what kept changing
    if (burst.changes >= MAX_CHANGES_PER_FRAME) {
      if (!burst.warned) {
        burst.warned = true;
        log.warn("virtual", `viewport keeps changing on re-render: ${JSON.stringify(prev)} → ${JSON.stringify(next)}`);
      }
      if (!burst.deferredFrame) {
        burst.deferredFrame = requestAnimationFrame(() => {
          burst.deferredFrame = 0;
          burst.changes = 0;
          measure();
        });
      }
      return;
    }
    burst.changes++;
    if (!burst.resetFrame) {
      burst.resetFrame = requestAnimationFrame(() => {
        burst.resetFrame = 0;
        burst.changes = 0;
      });
    }
    lastRef.current = next;
    setViewport(next);
  }, [listRef, scrollRef]);

  // The list element can be replaced (empty state ↔ list, view mode); observe whichever is mounted
  const observer = useRef<{ ro: ResizeObserver; el: HTMLElement } | null>(null);
  useLayoutEffect(() => {
    measure(true);
    const listEl = listRef.current;
    const scrollEl = scrollRef.current;
    if (observer.current?.el === listEl) return;
    observer.current?.ro.disconnect();
    observer.current = null;
    if (!listEl || !scrollEl) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(listEl);
    ro.observe(scrollEl);
    observer.current = { ro, el: listEl };
  });
  useEffect(
    () => () => {
      observer.current?.ro.disconnect();
      const burst = burstRef.current;
      cancelAnimationFrame(burst.resetFrame);
      cancelAnimationFrame(burst.deferredFrame);
      Object.assign(burst, { changes: 0, resetFrame: 0, deferredFrame: 0 });
    },
    []
  );

  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    let rafId: number | null = null;
    const onScroll = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        measure();
      });
    };
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [scrollRef, measure]);

  return viewport;
}
