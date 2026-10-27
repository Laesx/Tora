import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  HardDrive,
  Clock,
  MoreHorizontal,
  Plus,
  Minus,
  Star,
} from "lucide-react";
import { AnimeEntry } from "../types";
import { formatCountdown, getOptimizedCoverUrl } from "../api";
import { AnimeQuickMenu } from "./AnimeQuickMenu";

interface VirtualWatchlistProps {
  items: AnimeEntry[];
  viewMode: string;
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  quickMenuAnimeId: number | null;
  onSetQuickMenuAnimeId: (id: number | null) => void;
  onSelectAnime: (anime: AnimeEntry) => void;
  onStepEpisode: (anime: AnimeEntry, delta: number) => void;
  onSearchTorrents: (query: string) => void;
  onSimulatePlayback: (filename: string) => void;
}

export const VirtualWatchlist: React.FC<VirtualWatchlistProps> = ({
  items,
  viewMode,
  scrollContainerRef,
  quickMenuAnimeId,
  onSetQuickMenuAnimeId,
  onSelectAnime,
  onStepEpisode,
  onSearchTorrents,
  onSimulatePlayback,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(1080);
  const [viewportHeight, setViewportHeight] = useState<number>(800);
  const [scrollTop, setScrollTop] = useState<number>(0);
  const [listOffsetTop, setListOffsetTop] = useState<number>(0);

  const computeMenuPosition = useCallback((btn: HTMLElement | null) => {
    if (!btn) {
      setMenuPosition(null);
      return;
    }
    const rect = btn.getBoundingClientRect();
    const menuWidth = 320; // w-80
    const menuApproxHeight = 300;
    const left = Math.max(
      12,
      Math.min(window.innerWidth - menuWidth - 12, rect.right - menuWidth)
    );
    const top = Math.max(
      12,
      Math.min(window.innerHeight - menuApproxHeight - 12, rect.bottom + 6)
    );
    setMenuPosition({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!quickMenuAnimeId) {
      setMenuPosition(null);
      return;
    }
    computeMenuPosition(activeMenuTriggerRef.current);
  }, [quickMenuAnimeId, scrollTop, containerWidth, viewportHeight, computeMenuPosition]);

  // Measure container width & scroll viewport height via ResizeObserver
  useLayoutEffect(() => {
    const containerEl = containerRef.current;
    const scrollEl = scrollContainerRef.current;
    if (!containerEl || !scrollEl) return;

    const updateMeasurements = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.clientWidth || 1080);
        setListOffsetTop(containerRef.current.offsetTop || 0);
      }
      if (scrollContainerRef.current) {
        setViewportHeight(scrollContainerRef.current.clientHeight || 800);
        setScrollTop(scrollContainerRef.current.scrollTop || 0);
      }
    };

    updateMeasurements();

    const ro = new ResizeObserver(updateMeasurements);
    ro.observe(containerEl);
    ro.observe(scrollEl);

    return () => ro.disconnect();
  }, [scrollContainerRef, viewMode]);

  // Passive rAF-throttled scroll listener on `<main>`
  useEffect(() => {
    const scrollEl = scrollContainerRef.current;
    if (!scrollEl) return;

    let rafId: number | null = null;
    const onScroll = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (scrollContainerRef.current) {
          setScrollTop(scrollContainerRef.current.scrollTop);
        }
        if (containerRef.current) {
          setListOffsetTop(containerRef.current.offsetTop);
        }
      });
    };

    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [scrollContainerRef]);

  // Compute grid columns & exact row heights based on viewMode and containerWidth
  const layout = useMemo(() => {
    if (viewMode === "grid") {
      const cols =
        containerWidth >= 960
          ? 5
          : containerWidth >= 720
          ? 4
          : containerWidth >= 480
          ? 3
          : 2;
      const gap = 16;
      const cardWidth = Math.max(140, (containerWidth - (cols - 1) * gap) / cols);
      const imageHeight = Math.round(cardWidth * (4 / 3));
      const cardHeight = imageHeight + 64; // 4px progress bar + 60px footer
      const rowHeight = cardHeight + gap;
      return { cols, gap, cardHeight, rowHeight };
    }
    if (viewMode === "compact") {
      const cols = containerWidth >= 760 ? 2 : 1;
      const gap = 16;
      const cardHeight = 144;
      const rowHeight = cardHeight + gap;
      return { cols, gap, cardHeight, rowHeight };
    }
    // "table" mode
    return { cols: 1, gap: 0, cardHeight: 56, rowHeight: 56 };
  }, [viewMode, containerWidth]);

  const { startRow, endRow, totalRows, visibleItems } = useMemo(() => {
    const total = Math.ceil(items.length / layout.cols);
    if (total === 0) {
      return { startRow: 0, endRow: 0, totalRows: 0, visibleItems: [] };
    }
    const relScroll = Math.max(0, scrollTop - listOffsetTop);
    const overscan = 3;
    const sRow = Math.max(0, Math.floor(relScroll / layout.rowHeight) - overscan);
    const eRow = Math.min(
      total,
      Math.ceil((relScroll + viewportHeight) / layout.rowHeight) + overscan
    );
    const startIdx = sRow * layout.cols;
    const endIdx = Math.min(items.length, eRow * layout.cols);
    return {
      startRow: sRow,
      endRow: eRow,
      totalRows: total,
      visibleItems: items.slice(startIdx, endIdx),
    };
  }, [items, layout, scrollTop, listOffsetTop, viewportHeight]);

  const topSpacerHeight = startRow * layout.rowHeight;
  const bottomSpacerHeight = Math.max(0, (totalRows - endRow) * layout.rowHeight);

  if (items.length === 0) {
    return (
      <div
        ref={containerRef}
        className="py-16 text-center bg-bg-secondary border border-border-subtle rounded-2xl space-y-3"
      >
        <p className="text-sm font-semibold text-text-primary">
          No anime in this list view
        </p>
        <p className="text-xs text-text-muted">
          Use the Discover tab to add shows or sync your AniList account in Settings.
        </p>
      </div>
    );
  }

  if (viewMode === "grid") {
    const activeQuickMenuAnime =
      quickMenuAnimeId !== null
        ? items.find((a) => a.id === quickMenuAnimeId) ?? null
        : null;

    return (
      <div ref={containerRef} className="w-full">
        {topSpacerHeight > 0 && <div style={{ height: topSpacerHeight }} />}
        <div
          className="grid gap-4"
          style={{
            gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
          }}
        >
          {visibleItems.map((anime) => {
            const pct = anime.episodes
              ? Math.min(
                  100,
                  Math.round((anime.user_progress / anime.episodes) * 100)
                )
              : 50;
            const cd = formatCountdown(anime.next_airing_at);
            const isMenuOpen = quickMenuAnimeId === anime.id;

            return (
              <div
                key={anime.id}
                style={{ height: layout.cardHeight }}
                onClick={() => onSelectAnime(anime)}
                className="group relative bg-bg-secondary border border-border-subtle hover:border-accent/70 rounded-2xl overflow-visible flex flex-col cursor-pointer transition-colors shadow-sm hover:shadow-xl"
              >
                <div className="relative flex-1 w-full rounded-t-2xl overflow-hidden bg-bg-tertiary">
                  <img
                    src={getOptimizedCoverUrl(anime.cover_image, "large")}
                    alt={anime.title_romaji}
                    loading="lazy"
                    decoding="async"
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/15 to-transparent" />

                  {/* Top Left Badges: Disk Episodes & Airing Countdown */}
                  <div className="absolute top-2.5 left-2.5 flex flex-col gap-1">
                    {anime.local_episode_count > 0 && (
                      <span className="px-2 py-0.5 rounded-md bg-emerald-500/90 text-black text-[10px] font-bold flex items-center gap-1 shadow">
                        <HardDrive className="w-3 h-3" />
                        {anime.local_episode_count} on disk
                      </span>
                    )}
                    {cd && anime.next_airing_episode && (
                      <span className="px-2 py-0.5 rounded-md bg-black/85 text-emerald-400 text-[10px] font-mono font-semibold flex items-center gap-1">
                        <Clock className="w-2.5 h-2.5" />
                        Ep {anime.next_airing_episode} in {cd}
                      </span>
                    )}
                  </div>

                  {/* Top Right Quick Menu Trigger */}
                  <button
                    ref={(el) => {
                      if (isMenuOpen) {
                        activeMenuTriggerRef.current = el;
                      }
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isMenuOpen) {
                        activeMenuTriggerRef.current = null;
                        onSetQuickMenuAnimeId(null);
                      } else {
                        activeMenuTriggerRef.current = e.currentTarget;
                        computeMenuPosition(e.currentTarget);
                        onSetQuickMenuAnimeId(anime.id);
                      }
                    }}
                    className="absolute top-2.5 right-2.5 p-1.5 rounded-lg bg-black/75 hover:bg-accent text-white transition"
                    title="Quick Info Menu"
                  >
                    <MoreHorizontal className="w-4 h-4" />
                  </button>

                  {/* Bottom Overlay: Score & Progress +1 */}
                  <div className="absolute bottom-2.5 left-3 right-3 flex items-center justify-between text-white">
                    <span className="text-xs font-mono font-bold">
                      Ep {anime.user_progress} / {anime.episodes ?? "?"}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onStepEpisode(anime, 1);
                      }}
                      className="px-2 py-1 rounded-lg bg-accent hover:bg-accent-hover text-white text-[11px] font-bold flex items-center gap-0.5 shadow"
                      title="Increment Episode (+1)"
                    >
                      <Plus className="w-3 h-3" />1
                    </button>
                  </div>
                </div>

                {/* Progress Bar */}
                <div className="w-full h-1 bg-bg-tertiary overflow-hidden shrink-0">
                  <div
                    className="h-full bg-accent"
                    style={{ width: `${pct}%` }}
                  />
                </div>

                {/* Card Footer (fixed 60px height) */}
                <div className="p-3 h-[60px] shrink-0 flex flex-col justify-between">
                  <h3
                    className="text-xs font-bold text-text-primary line-clamp-1 group-hover:text-accent transition-colors"
                    title={anime.title_romaji}
                  >
                    {anime.title_romaji}
                  </h3>
                  <div className="flex items-center justify-between text-[11px] text-text-muted">
                    <span className="truncate">
                      {anime.studios[0] || anime.format}
                    </span>
                    {anime.user_score > 0 && (
                      <span className="flex items-center gap-0.5 text-amber-400 font-mono font-semibold shrink-0">
                        <Star className="w-3 h-3 fill-amber-400" />
                        {anime.user_score}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {bottomSpacerHeight > 0 && <div style={{ height: bottomSpacerHeight }} />}

        {/* Portaled Floating Quick Info Menu (renders on top of left sidebar & all cards) */}
        {activeQuickMenuAnime &&
          menuPosition &&
          createPortal(
            <div
              style={{
                position: "fixed",
                top: menuPosition.top,
                left: menuPosition.left,
                zIndex: 100,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <AnimeQuickMenu
                anime={activeQuickMenuAnime}
                onClose={() => onSetQuickMenuAnimeId(null)}
                onOpenFullModal={(a) => onSelectAnime(a)}
                onStepEpisode={onStepEpisode}
                onSearchTorrents={onSearchTorrents}
                onSimulatePlayback={onSimulatePlayback}
              />
            </div>,
            document.body
          )}
      </div>
    );
  }

  if (viewMode === "compact") {
    return (
      <div ref={containerRef} className="w-full">
        {topSpacerHeight > 0 && <div style={{ height: topSpacerHeight }} />}
        <div
          className="grid gap-4"
          style={{
            gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
          }}
        >
          {visibleItems.map((anime) => (
            <div
              key={anime.id}
              style={{ height: layout.cardHeight }}
              onClick={() => onSelectAnime(anime)}
              className="flex gap-4 p-3.5 rounded-2xl bg-bg-secondary border border-border-subtle hover:border-accent/60 cursor-pointer transition-colors"
            >
              <img
                src={getOptimizedCoverUrl(anime.cover_image, "medium")}
                alt={anime.title_romaji}
                loading="lazy"
                decoding="async"
                className="w-20 h-28 object-cover rounded-xl shrink-0"
              />
              <div className="flex-1 min-w-0 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-bold text-text-primary truncate">
                      {anime.title_romaji}
                    </h3>
                    <span className="px-2 py-0.5 rounded bg-bg-tertiary text-[10px] font-mono text-text-secondary shrink-0">
                      {anime.format}
                    </span>
                  </div>
                  <p className="text-[11px] text-text-muted line-clamp-2 mt-1">
                    {anime.synopsis}
                  </p>
                </div>

                <div className="flex items-center justify-between gap-2 pt-2 border-t border-border-subtle text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-accent">
                      Ep {anime.user_progress} / {anime.episodes ?? "?"}
                    </span>
                    {anime.local_episode_count > 0 && (
                      <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 text-[10px] font-mono">
                        {anime.local_episode_count} local
                      </span>
                    )}
                  </div>

                  <div
                    className="flex items-center gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={() => onStepEpisode(anime, -1)}
                      className="p-1.5 rounded-lg bg-bg-primary hover:bg-bg-tertiary border border-border-subtle text-text-secondary"
                    >
                      <Minus className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => onStepEpisode(anime, 1)}
                      className="px-2.5 py-1 rounded-lg bg-accent hover:bg-accent-hover text-white font-semibold text-xs flex items-center gap-1"
                    >
                      <Plus className="w-3 h-3" />1
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
        {bottomSpacerHeight > 0 && <div style={{ height: bottomSpacerHeight }} />}
      </div>
    );
  }

  // "table" mode (Taiga Classic Dense Table View)
  return (
    <div
      ref={containerRef}
      className="bg-bg-secondary border border-border-subtle rounded-2xl overflow-hidden"
    >
      <table className="w-full text-left border-collapse text-xs">
        <thead className="bg-bg-tertiary text-text-muted uppercase text-[10px]">
          <tr>
            <th className="py-2.5 px-4">Anime Title</th>
            <th className="py-2.5 px-3">Type</th>
            <th className="py-2.5 px-3">Progress</th>
            <th className="py-2.5 px-3">On Disk</th>
            <th className="py-2.5 px-3">Score</th>
            <th className="py-2.5 px-3">Season</th>
            <th className="py-2.5 px-4 text-right">Quick Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {topSpacerHeight > 0 && (
            <tr style={{ height: topSpacerHeight }} aria-hidden="true">
              <td colSpan={7} className="p-0 border-0" />
            </tr>
          )}
          {visibleItems.map((anime) => {
            const pct = anime.episodes
              ? Math.min(
                  100,
                  Math.round((anime.user_progress / anime.episodes) * 100)
                )
              : 50;
            return (
              <tr
                key={anime.id}
                style={{ height: layout.rowHeight }}
                onClick={() => onSelectAnime(anime)}
                className="hover:bg-bg-tertiary/60 cursor-pointer transition-colors"
              >
                <td className="py-2 px-4 flex items-center gap-3">
                  <img
                    src={getOptimizedCoverUrl(anime.cover_image, "medium")}
                    alt={anime.title_romaji}
                    loading="lazy"
                    decoding="async"
                    className="w-7 h-10 object-cover rounded shrink-0"
                  />
                  <div className="min-w-0">
                    <div className="font-semibold text-text-primary truncate max-w-md">
                      {anime.title_romaji}
                    </div>
                    <div className="text-[10px] text-text-muted truncate max-w-md">
                      {anime.studios.join(", ")}
                    </div>
                  </div>
                </td>
                <td className="py-2 px-3 font-mono text-[11px] text-text-secondary">
                  {anime.format}
                </td>
                <td className="py-2 px-3 w-44">
                  <div className="flex items-center justify-between text-[11px] font-mono mb-1">
                    <span>
                      {anime.user_progress} / {anime.episodes ?? "?"}
                    </span>
                    <span className="text-text-muted">{pct}%</span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
                    <div
                      className="h-full bg-accent rounded-full"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </td>
                <td className="py-2 px-3 font-mono text-[11px]">
                  {anime.local_episode_count > 0 ? (
                    <span className="text-emerald-400 font-semibold">
                      {anime.local_episode_count} files
                    </span>
                  ) : (
                    <span className="text-text-muted">-</span>
                  )}
                </td>
                <td className="py-2 px-3 font-mono font-bold text-amber-400">
                  {anime.user_score > 0 ? anime.user_score : "-"}
                </td>
                <td className="py-2 px-3 text-[11px] text-text-secondary">
                  {anime.season || ""} {anime.season_year || ""}
                </td>
                <td
                  className="py-2 px-4 text-right"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => onStepEpisode(anime, -1)}
                      className="p-1.5 rounded bg-bg-primary hover:bg-bg-tertiary border border-border-subtle text-text-secondary"
                    >
                      <Minus className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => onStepEpisode(anime, 1)}
                      className="px-2 py-1 rounded bg-accent hover:bg-accent-hover text-white font-mono font-bold text-[11px]"
                    >
                      +1
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
          {bottomSpacerHeight > 0 && (
            <tr style={{ height: bottomSpacerHeight }} aria-hidden="true">
              <td colSpan={7} className="p-0 border-0" />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
};
