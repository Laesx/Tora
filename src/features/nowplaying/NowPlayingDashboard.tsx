import React, { useEffect, useMemo, useState } from "react";
import { CalendarCheck, CalendarPlus, Clock, Film, HardDrive, Play, Tv } from "lucide-react";
import { AnimeEntry, WatchStats } from "@/lib/types";
import { getOptimizedCoverUrl } from "@/lib/covers";
import { toraApi } from "@/lib/api";
import {
  formatFuzzyDate,
  formatMinutes,
  fuzzyDateToDate,
  playLocalEpisode,
  unwatchedOnDisk,
} from "@/lib/anime";
import { AnimeQuickMenu } from "@/components/AnimeQuickMenu";
import { FloatingQuickMenu } from "@/components/FloatingQuickMenu";
import { STATUS_INFO } from "@/lib/status";
import { AiringDot } from "@/components/AiringDot";
import { useAnimeTitle } from "@/contexts/titles";
import { useToast } from "@/contexts/toast";
import { useAnimeActions } from "@/contexts/animeActions";
import { log } from "@/lib/log";

interface NowPlayingDashboardProps {
  animeList: AnimeEntry[];
}

const CONTINUE_LIMIT = 12;
const RECENT_DAYS = 14;
const WATCHING = ["CURRENT", "REPEATING"];

/** Watch time left on an anime that finished airing (episode count known); 24 min/episode when the duration is unknown. */
function timeToFinish(a: AnimeEntry): { episodes: number; perEpisode: number; minutes: number } | null {
  if (a.airing_status !== "FINISHED" || !a.episodes) return null;
  const episodes = a.episodes - a.user_progress;
  if (episodes <= 0) return null;
  const perEpisode = a.duration && a.duration > 0 ? a.duration : 24;
  return { episodes, perEpisode, minutes: episodes * perEpisode };
}

/** Idle state of the Now Playing tab: stats, continue watching and recent airing changes. */
export const NowPlayingDashboard: React.FC<NowPlayingDashboardProps> = ({
  animeList,
}) => {
  const showToast = useToast();
  const { openAnime } = useAnimeActions();
  const titleOf = useAnimeTitle();
  const [stats, setStats] = useState<WatchStats | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [menu, setMenu] = useState<{ anime: AnimeEntry; x: number; y: number } | null>(null);

  // History changes with every progress update, so the list is a good refresh signal
  useEffect(() => {
    let cancelled = false;
    toraApi
      .getWatchStats()
      .then((s) => !cancelled && setStats(s))
      .catch((e) => log.error("nowplaying", "Failed to load watch stats", e));
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
              const left = timeToFinish(a);
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
                      alt={titleOf(a)}
                      loading="lazy"
                      decoding="async"
                      className="w-full h-full object-cover"
                    />
                    <span className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition flex items-center justify-center">
                      <Play className="w-5 h-5 text-white fill-current" />
                    </span>
                    <AiringDot anime={a} size="sm" onCover className="absolute top-1 left-1" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold text-text-primary truncate">{titleOf(a)}</div>
                    <div className="text-[11px] font-semibold text-emerald-400 mt-1">Ep {next} ready</div>
                    <div className="text-[10px] text-text-muted mt-0.5">
                      {a.user_progress}/{a.episodes ?? "?"}
                      {more > 0 ? ` · +${more} more on disk` : ""}
                    </div>
                    {left && (
                      <div
                        className="text-[10px] text-text-secondary mt-0.5 flex items-center gap-1"
                        title={`${left.episodes} episode${left.episodes === 1 ? "" : "s"} left × ${left.perEpisode} min`}
                      >
                        <Clock className="w-3 h-3 shrink-0 text-text-muted" />~{formatMinutes(left.minutes)} to finish
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Recent airing changes */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <RecentList
          icon={<CalendarPlus className="w-4 h-4 text-accent" />}
          title="Recently Started Airing"
          items={recentlyStarted}
          dateOf={(a) => a.start_date}
          empty={`Nothing on your list started airing in the last ${RECENT_DAYS} days.`}
        />
        <RecentList
          icon={<CalendarCheck className="w-4 h-4 text-accent" />}
          title="Recently Finished Airing"
          items={recentlyFinished}
          dateOf={(a) => a.end_date}
          empty={`Nothing on your list finished airing in the last ${RECENT_DAYS} days.`}
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
            onOpenFullModal={openAnime}
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
}> = ({ icon, title, items, dateOf, empty }) => {
  const { openAnime } = useAnimeActions();
  const titleOf = useAnimeTitle();
  return (
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
          const status = STATUS_INFO[a.user_status];
          return (
            <button
              key={a.id}
              onClick={() => openAnime(a)}
              className="w-full flex items-center gap-3 p-2 rounded-xl hover:bg-bg-tertiary text-left transition focus:outline-none"
            >
              <span className="relative shrink-0">
                <img
                  src={getOptimizedCoverUrl(a.cover_image, "medium")}
                  alt={titleOf(a)}
                  loading="lazy"
                  decoding="async"
                  className="w-8 h-11 object-cover rounded-md"
                />
                <AiringDot anime={a} size="sm" onCover className="absolute -top-0.5 -left-0.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-text-primary truncate">{titleOf(a)}</div>
                <div className="text-[10px] text-text-muted">{formatFuzzyDate(dateOf(a))}</div>
              </div>
              {status && (
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0 ${status.badge}`}>
                  {status.shortLabel}
                </span>
              )}
            </button>
          );
        })}
      </div>
    )}
  </section>
  );
};
