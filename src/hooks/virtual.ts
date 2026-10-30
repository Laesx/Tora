import { RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

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

  const measure = useCallback(() => {
    const listEl = listRef.current;
    const scrollEl = scrollRef.current;
    if (!listEl || !scrollEl) return;
    const next: ScrollViewport = {
      width: listEl.clientWidth || FALLBACK.width,
      top: Math.round(listEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop),
      scrollTop: scrollEl.scrollTop,
      viewportHeight: scrollEl.clientHeight || FALLBACK.viewportHeight,
    };
    setViewport((prev) =>
      prev.width === next.width &&
      prev.top === next.top &&
      prev.scrollTop === next.scrollTop &&
      prev.viewportHeight === next.viewportHeight
        ? prev
        : next
    );
  }, [listRef, scrollRef]);

  // The list element can be replaced (empty state ↔ list, view mode); observe whichever is mounted
  const observer = useRef<{ ro: ResizeObserver; el: HTMLElement } | null>(null);
  useLayoutEffect(() => {
    measure();
    const listEl = listRef.current;
    const scrollEl = scrollRef.current;
    if (observer.current?.el === listEl) return;
    observer.current?.ro.disconnect();
    observer.current = null;
    if (!listEl || !scrollEl) return;
    const ro = new ResizeObserver(measure);
    ro.observe(listEl);
    ro.observe(scrollEl);
    observer.current = { ro, el: listEl };
  });
  useEffect(() => () => observer.current?.ro.disconnect(), []);

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
