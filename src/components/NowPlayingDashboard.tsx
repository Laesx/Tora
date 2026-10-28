import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarCheck, CalendarPlus, Clock, Film, HardDrive, Play, Tv } from "lucide-react";
import { AnimeEntry, BatchAnimeUpdatePatch, WatchStats } from "../types";
import { getOptimizedCoverUrl, toraApi } from "../api";
import {
  formatFuzzyDate,
  formatMinutes,
  fuzzyDateToDate,
  playLocalEpisode,
  unwatchedOnDisk,
} from "../nowPlaying";
import { AiringCountdown } from "./AiringCountdown";
import { AnimeQuickMenu } from "./AnimeQuickMenu";
import { LIST_STATUS_META } from "./AnimePosterCard";

interface NowPlayingDashboardProps {
  animeList: AnimeEntry[];
  onOpenAnime: (anime: AnimeEntry) => void;
  onStepEpisode: (anime: AnimeEntry, delta: number) => void;
  onBatchUpdate: (patch: BatchAnimeUpdatePatch, summaryToast: string) => Promise<void>;
  onBatchDelete: (animeList: AnimeEntry[]) => Promise<void>;
  onSearchTorrents: (query: string) => void;
  onDeleteAnime: (anime: AnimeEntry) => void;
  showToast: (msg: string, type?: "success" | "info" | "error") => void;
}

const CONTINUE_LIMIT = 12;
const RECENT_DAYS = 14;
const WATCHING = ["CURRENT", "REPEATING"];

/** Idle state of the Now Playing tab: stats, continue watching, airing countdown and recent airing changes. */
export const NowPlayingDashboard: React.FC<NowPlayingDashboardProps> = ({
  animeList,
  onOpenAnime,
  onStepEpisode,
  onBatchUpdate,
  onBatchDelete,
  onSearchTorrents,
  onDeleteAnime,
  showToast,
}) => {
  const [stats, setStats] = useState<WatchStats | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [menu, setMenu] = useState<{ anime: AnimeEntry; x: number; y: number } | null>(null);

  // History changes with every progress update, so the list is a good refresh signal
  useEffect(() => {
    let cancelled = false;
    toraApi
      .getWatchStats()
      .then((s) => !cancelled && setStats(s))
      .catch((e) => console.error("Failed to load watch stats:", e));
    return () => {
      cancelled = true;
    };
  }, [animeList]);

  const continueWatching = useMemo(
    () =>
      animeList
        .filter(
          (a) => WATCHING.includes(a.user_status) && a.available_episodes.includes(a.user_progress + 1)
        )
        .sort((a, b) => b.updated_at - a.updated_at),
    [animeList]
  );

  const totals = useMemo(() => {
    let onDisk = 0;
    let showsWithNew = 0;
    let watching = 0;
    let airing = 0;
    for (const a of animeList) {
      if (WATCHING.includes(a.user_status)) {
        watching++;
        if (a.airing_status === "RELEASING") airing++;
      }
      if (a.user_status === "COMPLETED" || a.user_status === "DROPPED") continue;
      const n = unwatchedOnDisk(a).length;
      onDisk += n;
      if (n > 0) showsWithNew++;
    }
    return { onDisk, showsWithNew, watching, airing };
  }, [animeList]);

  const { recentlyStarted, recentlyFinished } = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const from = new Date(today);
    from.setDate(from.getDate() - RECENT_DAYS);
    const inWindow = (d: Date | null) => !!d && d >= from && d <= today;
    const byDateDesc = (key: "start_date" | "end_date") => (a: AnimeEntry, b: AnimeEntry) =>
      (b[key] ?? "").localeCompare(a[key] ?? "");
    const candidates = animeList.filter((a) => a.user_status !== "DROPPED");
    const recentlyFinished = candidates
      .filter((a) => a.airing_status === "FINISHED" && inWindow(fuzzyDateToDate(a.end_date)))
      .sort(byDateDesc("end_date"));
    // An anime that both started and finished in the window (e.g. a single-day release) is only "finished"
    const finishedIds = new Set(recentlyFinished.map((a) => a.id));
    return {
      recentlyStarted: candidates
        .filter((a) => !finishedIds.has(a.id) && inWindow(fuzzyDateToDate(a.start_date)))
        .sort(byDateDesc("start_date")),
      recentlyFinished,
    };
  }, [animeList]);

  const weekDelta = stats ? stats.episodes_last_week - stats.episodes_prev_week : 0;
  const visibleContinue = showAll ? continueWatching : continueWatching.slice(0, CONTINUE_LIMIT);

  return (
    <div className="space-y-5">
      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile
          icon={<Film className="w-4 h-4" />}
          value={stats ? stats.episodes_last_week.toLocaleString() : "—"}
          label="episodes watched in the last 7 days"
          note={
            stats && (stats.episodes_last_week > 0 || stats.episodes_prev_week > 0)
              ? weekDelta === 0
                ? "same as the week before"
                : `${weekDelta > 0 ? "+" : ""}${weekDelta} vs the week before`
              : undefined
          }
        />
        <StatTile
          icon={<Clock className="w-4 h-4" />}
          value={stats ? formatMinutes(stats.minutes_last_week) : "—"}
          label="spent watching in the last 7 days"
        />
        <StatTile
          icon={<HardDrive className="w-4 h-4" />}
          value={totals.onDisk.toLocaleString()}
          label="new episodes on disk"
          note={totals.showsWithNew > 0 ? `across ${totals.showsWithNew} anime` : undefined}
        />
        <StatTile
          icon={<Tv className="w-4 h-4" />}
          value={totals.watching.toLocaleString()}
          label="anime you're watching"
          note={totals.airing > 0 ? `${totals.airing} currently airing` : undefined}
        />
      </div>

      {/* Continue watching */}
      <section className="bg-bg-secondary border border-border-subtle rounded-2xl p-4 space-y-3">
        <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
          <Play className="w-4 h-4 text-accent" />
          Continue Watching
          <span className="text-[11px] font-medium text-text-muted">{continueWatching.length}</span>
          {continueWatching.length > CONTINUE_LIMIT && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="ml-auto text-[11px] font-semibold text-accent hover:underline"
            >
              {showAll ? "Show less" : "Show all"}
            </button>
          )}
        </h2>
        {continueWatching.length === 0 ? (
          <div className="py-6 text-center text-xs text-text-muted">
            No next episodes on disk for the anime you're watching.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {visibleContinue.map((a) => {
              const next = a.user_progress + 1;
              const more = unwatchedOnDisk(a).length - 1;
              return (
                <button
                  key={a.id}
                  onClick={() => playLocalEpisode(a, next, showToast)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenu({ anime: a, x: e.clientX, y: e.clientY });
                  }}
                  title={`Play episode ${next}`}
                  className="group flex items-center gap-3 p-2.5 rounded-xl bg-bg-primary border border-border-subtle hover:border-accent/60 text-left transition focus:outline-none"
                >
                  <div className="relative w-11 h-16 shrink-0 rounded-lg overflow-hidden">
                    <img
                      src={getOptimizedCoverUrl(a.cover_image, "medium")}
                      alt={a.title_romaji}
                      loading="lazy"
                      decoding="async"
                      className="w-full h-full object-cover"
                    />
                    <span className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition flex items-center justify-center">
                      <Play className="w-5 h-5 text-white fill-current" />
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold text-text-primary truncate">{a.title_romaji}</div>
                    <div className="text-[11px] font-semibold text-emerald-400 mt-1">Ep {next} ready</div>
                    <div className="text-[10px] text-text-muted mt-0.5">
                      {a.user_progress}/{a.episodes ?? "?"}
                      {more > 0 ? ` · +${more} more on disk` : ""}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <AiringCountdown animeList={animeList} onOpenAnime={onOpenAnime} />

      {/* Recent airing changes */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <RecentList
          icon={<CalendarPlus className="w-4 h-4 text-accent" />}
          title="Recently Started Airing"
          items={recentlyStarted}
          dateOf={(a) => a.start_date}
          empty={`Nothing on your list started airing in the last ${RECENT_DAYS} days.`}
          onOpenAnime={onOpenAnime}
        />
        <RecentList
          icon={<CalendarCheck className="w-4 h-4 text-accent" />}
          title="Recently Finished Airing"
          items={recentlyFinished}
          dateOf={(a) => a.end_date}
          empty={`Nothing on your list finished airing in the last ${RECENT_DAYS} days.`}
          onOpenAnime={onOpenAnime}
        />
      </div>

      {menu && (
        <FloatingQuickMenu
          anchor={menu}
          onClose={() => setMenu(null)}
        >
          <AnimeQuickMenu
            anime={animeList.find((a) => a.id === menu.anime.id) ?? menu.anime}
            onClose={() => setMenu(null)}
            onOpenFullModal={onOpenAnime}
            onStepEpisode={onStepEpisode}
            onBatchUpdate={onBatchUpdate}
            onBatchDelete={onBatchDelete}
            onSearchTorrents={onSearchTorrents}
            onDeleteAnime={onDeleteAnime}
            showToast={showToast}
          />
        </FloatingQuickMenu>
      )}
    </div>
  );
};

const StatTile: React.FC<{ icon: React.ReactNode; value: string; label: string; note?: string }> = ({
  icon,
  value,
  label,
  note,
}) => (
  <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-4">
    <div className="flex items-center gap-2 text-accent">
      {icon}
      <span className="text-xl font-extrabold text-text-primary">{value}</span>
    </div>
    <div className="text-[11px] text-text-secondary mt-1">{label}</div>
    {note && <div className="text-[10px] text-text-muted mt-0.5">{note}</div>}
  </div>
);

const RecentList: React.FC<{
  icon: React.ReactNode;
  title: string;
  items: AnimeEntry[];
  dateOf: (a: AnimeEntry) => string | null;
  empty: string;
  onOpenAnime: (anime: AnimeEntry) => void;
}> = ({ icon, title, items, dateOf, empty, onOpenAnime }) => (
  <section className="bg-bg-secondary border border-border-subtle rounded-2xl p-4 space-y-3">
    <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
      {icon}
      {title}
      <span className="text-[11px] font-medium text-text-muted">{items.length}</span>
    </h2>
    {items.length === 0 ? (
      <div className="py-4 text-center text-xs text-text-muted">{empty}</div>
    ) : (
      <div className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
        {items.map((a) => {
          const status = LIST_STATUS_META[a.user_status];
          return (
            <button
              key={a.id}
              onClick={() => onOpenAnime(a)}
              className="w-full flex items-center gap-3 p-2 rounded-xl hover:bg-bg-tertiary text-left transition focus:outline-none"
            >
              <img
                src={getOptimizedCoverUrl(a.cover_image, "medium")}
                alt={a.title_romaji}
                loading="lazy"
                decoding="async"
                className="w-8 h-11 object-cover rounded-md shrink-0"
              />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-text-primary truncate">{a.title_romaji}</div>
                <div className="text-[10px] text-text-muted">{formatFuzzyDate(dateOf(a))}</div>
              </div>
              {status && (
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0 ${status.badge}`}>
                  {status.label}
                </span>
              )}
            </button>
          );
        })}
      </div>
    )}
  </section>
);

/** Portal that keeps a context menu inside the viewport and closes it on outside click / Escape / scroll. */
const FloatingQuickMenu: React.FC<{
  anchor: { x: number; y: number };
  onClose: () => void;
  children: React.ReactNode;
}> = ({ anchor, onClose, children }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ top: anchor.y, left: anchor.x });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const clamp = () => {
      const rect = el.getBoundingClientRect();
      setPosition({
        left: Math.max(8, Math.min(window.innerWidth - rect.width - 8, anchor.x)),
        top: Math.max(8, Math.min(window.innerHeight - rect.height - 8, anchor.y)),
      });
    };
    clamp();
    const ro = new ResizeObserver(clamp);
    ro.observe(el);
    return () => ro.disconnect();
  }, [anchor.x, anchor.y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = (e: Event) => {
      if (ref.current && ref.current.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      style={{ position: "fixed", top: position.top, left: position.left, zIndex: 100 }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body
  );
};
