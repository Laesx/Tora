import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Download, History, Loader2, RefreshCw, Search, Undo2, X } from "lucide-react";
import { AnimeEntry, HistoryRow, HistorySource, MANUAL_HISTORY_PLAYER, TimelineEpisode } from "@/lib/types";
import { getOptimizedCoverUrl } from "@/lib/covers";
import { toraApi } from "@/lib/api";
import { useAnimeTitle } from "@/contexts/titles";
import { AiringDot } from "@/components/AiringDot";
import { useAnimeActions } from "@/contexts/animeActions";
import { importProgress, useAniListHistory } from "@/contexts/anilistHistory";
import { plural } from "@/lib/format";

import { log } from "@/lib/log";
interface HistoryViewProps {
  animeList: AnimeEntry[];
  /** Changes whenever a new history row may exist (scrobble / list update) */
  refreshKey: unknown;
}

const PAGE_SIZE = 100;
const SEARCH_DEBOUNCE_MS = 250;

const SOURCES: [HistorySource, string][] = [
  ["all", "All"],
  ["anilist", "AniList"],
  ["local", "Local"],
];

function dayLabel(ts: number): string {
  const d = new Date(ts * 1000);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

function timeLabel(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** "3 episodes · 1 correction" for a day group (corrections are not counted as episodes). */
function dayCountLabel(items: HistoryRow[]): string {
  const corrections = items.filter((h) => h.progress_from !== null).length;
  const episodes = items.reduce((n, h) => n + (h.progress_from === null ? h.episode_count : 0), 0);
  const parts = [plural(episodes, "episode")];
  if (corrections > 0) parts.push(plural(corrections, "correction"));
  return parts.join(" · ");
}

/** "Ep 4", "Ep 4–12", or "Ep 4–12 (7)" when Tora logged some episodes in between itself */
function episodeLabel(h: HistoryRow): string {
  if (h.episode_from === h.episode_to) return `Ep ${h.episode_from}`;
  const span = h.episode_to - h.episode_from + 1;
  return `Ep ${h.episode_from}–${h.episode_to}${h.episode_count < span ? ` (${h.episode_count})` : ""}`;
}

function groupByDay<T>(items: T[], ts: (item: T) => number): { label: string; items: T[] }[] {
  const out: { label: string; items: T[] }[] = [];
  for (const item of items) {
    const label = dayLabel(ts(item));
    const last = out[out.length - 1];
    if (last && last.label === label) last.items.push(item);
    else out.push({ label, items: [item] });
  }
  return out;
}

const Cover: React.FC<{ anime?: AnimeEntry; cover?: string | null; alt: string }> = ({ anime, cover, alt }) => {
  const src = anime?.cover_image || cover;
  if (!src) return <div className="w-8 h-11 rounded-md bg-bg-tertiary shrink-0" />;
  return (
    <span className="relative shrink-0">
      <img
        src={getOptimizedCoverUrl(src, "medium")}
        alt={alt}
        loading="lazy"
        decoding="async"
        className="w-8 h-11 object-cover rounded-md"
      />
      {anime && <AiringDot anime={anime} size="sm" onCover className="absolute -top-0.5 -left-0.5" />}
    </span>
  );
};

const AniListBadge: React.FC = () => (
  <span className="px-1.5 py-px rounded-md bg-sky-500/15 text-sky-400 text-[9px] font-bold uppercase tracking-wide">
    AniList
  </span>
);

/**
 * Every watched episode, newest first: what Tora logged (player scrobbles, manual progress changes) and,
 * once imported, the user's AniList activity for episodes Tora never logged (local rows win). Pages
 * load from the backend by cursor, and the title search covers the whole history. Clicking a title
 * shows that anime's episode timeline.
 */
export const HistoryView: React.FC<HistoryViewProps> = ({ animeList, refreshKey }) => {
  const { openAnime } = useAnimeActions();
  const titleOf = useAnimeTitle();
  const anilist = useAniListHistory();
  const showSources = anilist.enabled || anilist.hasData;
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [sourceChoice, setSource] = useState<HistorySource>("all");
  const source: HistorySource = showSources ? sourceChoice : "local";
  const [animeFilter, setAnimeFilter] = useState<{ id: number; title: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Pages past the first were loaded: background updates leave them alone instead of resetting
  const pagedRef = useRef(false);
  // Only the newest request may write rows
  const requestRef = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setSearch(filter.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [filter]);

  const load = useCallback(
    async (append: HistoryRow | null) => {
      const request = ++requestRef.current;
      setLoading(true);
      try {
        const page = await toraApi.listHistory({
          source,
          search: search || null,
          before: append?.cursor ?? null,
          limit: PAGE_SIZE,
        });
        if (request !== requestRef.current) return;
        pagedRef.current = append !== null;
        setRows((prev) => (append ? [...prev, ...page] : page));
        setHasMore(page.length === PAGE_SIZE);
      } catch (e) {
        log.error("history", "Loading watch history failed", e);
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    },
    [source, search]
  );

  useEffect(() => {
    pagedRef.current = false;
    void load(null);
  }, [load, refreshKey]);

  // Imported pages arrive every few seconds during an import: refresh the first page only
  useEffect(() => {
    if (anilist.version > 0 && !pagedRef.current && source !== "local") void load(null);
  }, [anilist.version]);

  const byId = useMemo(() => new Map(animeList.map((a) => [a.id, a])), [animeList]);

  // Live entries show in the chosen title language; rows of other anime keep the logged title
  const rowTitle = useCallback(
    (h: HistoryRow) => {
      const anime = h.anime_id !== null ? byId.get(h.anime_id) : undefined;
      return anime ? titleOf(anime) : h.anime_title;
    },
    [byId, titleOf]
  );

  const groups = useMemo(() => groupByDay(rows, (h) => h.timestamp_unix), [rows]);

  const refreshAniList = async () => {
    setRefreshing(true);
    await anilist.refresh();
    setRefreshing(false);
  };

  const status = anilist.status;
  const importing = status?.status === "running" || status?.status === "paused";

  return (
    <div className="p-6 space-y-5 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-bold text-text-primary flex items-center gap-2.5">
          <History className="w-6 h-6 text-accent" />
          History
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          {importing && (
            <button
              onClick={anilist.openImport}
              title="AniList history import"
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-bg-secondary border border-border-subtle hover:bg-bg-tertiary text-[11px] font-semibold text-text-secondary transition"
            >
              {status?.status === "running" && status.active ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />
              ) : (
                <Download className="w-3.5 h-3.5 text-amber-400" />
              )}
              AniList import {Math.round(importProgress(status) * 100)}%
            </button>
          )}
          {!showSources && !importing && (
            <button
              onClick={anilist.openImport}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-bg-secondary border border-border-subtle hover:bg-bg-tertiary text-xs font-semibold text-text-secondary hover:text-text-primary transition"
            >
              <Download className="w-3.5 h-3.5" />
              Import from AniList
            </button>
          )}
          {!animeFilter && (
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-text-muted absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by title..."
                className="pl-8 pr-3 py-1.5 rounded-xl bg-bg-secondary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent w-52"
              />
            </div>
          )}
          {showSources && !animeFilter && (
            <div className="flex items-center bg-bg-secondary p-1 rounded-xl border border-border-subtle">
              {SOURCES.map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setSource(id)}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold transition ${
                    source === id ? "bg-accent text-white" : "text-text-secondary hover:text-text-primary"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {anilist.enabled && status?.status === "done" && (
            <button
              onClick={() => void refreshAniList()}
              disabled={refreshing || status.active}
              title="Fetch new activity from AniList"
              className="p-2 rounded-xl bg-bg-secondary border border-border-subtle hover:bg-bg-tertiary text-text-secondary hover:text-text-primary disabled:opacity-50 transition"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
            </button>
          )}
        </div>
      </div>

      {animeFilter ? (
        <AnimeTimeline
          animeId={animeFilter.id}
          title={animeFilter.title}
          anime={byId.get(animeFilter.id)}
          refreshKey={[refreshKey, anilist.version]}
          onBack={() => setAnimeFilter(null)}
        />
      ) : groups.length === 0 ? (
        <div className="bg-bg-secondary border border-border-subtle rounded-2xl py-16 text-center text-xs text-text-muted space-y-3">
          <p>
            {loading
              ? "Loading..."
              : search
                ? "No entries match the filter."
                : source === "anilist"
                  ? anilist.hasData
                    ? "Every episode in your AniList history was also logged by Tora."
                    : "Nothing imported from AniList yet."
                  : "No history yet. Play an episode or update your progress to start tracking."}
          </p>
          {source === "anilist" && !anilist.hasData && !importing && (
            <button
              onClick={anilist.openImport}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-accent hover:bg-accent-hover text-white text-xs font-semibold transition"
            >
              <Download className="w-3.5 h-3.5" />
              Import from AniList
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <section
              key={g.label}
              className="bg-bg-secondary border border-border-subtle rounded-2xl p-4 space-y-1"
            >
              <h2 className="text-xs font-bold text-text-secondary pb-1">
                {g.label}
                <span className="ml-2 font-medium text-text-muted">{dayCountLabel(g.items)}</span>
              </h2>
              {g.items.map((h) => {
                const anime = h.anime_id !== null ? byId.get(h.anime_id) : undefined;
                const remote = h.kind === "anilist";
                const manual = h.player_name === MANUAL_HISTORY_PLAYER;
                const correction = h.progress_from !== null;
                const title = rowTitle(h);
                return (
                  <div
                    key={`${h.kind}-${h.id}`}
                    className="w-full flex items-center gap-3 p-2 rounded-xl hover:bg-bg-tertiary transition"
                  >
                    <button
                      disabled={!anime}
                      onClick={() => anime && openAnime(anime)}
                      title={anime ? "Open details" : undefined}
                      className="shrink-0 focus:outline-none disabled:cursor-default"
                    >
                      <Cover anime={anime} cover={h.cover} alt={title} />
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-text-primary truncate">
                        <button
                          disabled={h.anime_id === null}
                          onClick={() => h.anime_id !== null && setAnimeFilter({ id: h.anime_id, title })}
                          title="Show every episode of this anime"
                          className="hover:underline disabled:no-underline focus:outline-none text-left"
                        >
                          {title}
                        </button>{" "}
                        {correction ? (
                          <span className="text-text-muted font-mono">
                            Ep {h.progress_from} → {h.episode_to}
                          </span>
                        ) : (
                          <span className="text-accent font-mono">{episodeLabel(h)}</span>
                        )}
                      </div>
                      <div className="text-[11px] text-text-muted font-mono truncate flex items-center gap-1">
                        {remote ? (
                          <>
                            {source === "all" && <AniListBadge />}
                            {h.rewatch ? "Rewatched on AniList" : "Watched on AniList"}
                          </>
                        ) : correction ? (
                          <>
                            <Undo2 className="w-3 h-3 shrink-0" />
                            Progress corrected
                          </>
                        ) : manual ? (
                          "Manual update"
                        ) : (
                          `${h.player_name}${h.file_name ? ` • ${h.file_name}` : ""}`
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <span className="text-[10px] font-mono text-text-muted block">{timeLabel(h.timestamp_unix)}</span>
                      {!remote && !manual && h.scrobbled_to_tracker && (
                        <span className="text-[10px] text-emerald-400 font-semibold">Synced</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}

      {!animeFilter && hasMore && (
        <div className="flex justify-center">
          <button
            onClick={() => void load(rows[rows.length - 1] ?? null)}
            disabled={loading}
            className="px-4 py-2 rounded-xl bg-bg-secondary border border-border-subtle hover:bg-bg-tertiary text-xs font-semibold text-text-secondary disabled:opacity-50 transition"
          >
            {loading ? "Loading..." : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
};

const SOURCE_LABEL: Record<TimelineEpisode["source"], string> = {
  player: "",
  manual: "Manual update",
  anilist: "AniList",
};

/** One anime's watched episodes, oldest first, with when each was logged and where. */
const AnimeTimeline: React.FC<{
  animeId: number;
  title: string;
  anime?: AnimeEntry;
  refreshKey: unknown[];
  onBack: () => void;
}> = ({ animeId, title, anime, refreshKey, onBack }) => {
  const { openAnime } = useAnimeActions();
  const [episodes, setEpisodes] = useState<TimelineEpisode[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    toraApi
      .getHistoryTimeline(animeId)
      .then((t) => !cancelled && setEpisodes(t))
      .catch((e) => log.error("history", "Loading the anime timeline failed", e));
    return () => {
      cancelled = true;
    };
  }, [animeId, ...refreshKey]);

  const groups = useMemo(() => groupByDay(episodes ?? [], (e) => e.timestamp_unix), [episodes]);
  const summary = useMemo(() => {
    if (!episodes?.length) return null;
    const distinct = new Set(episodes.map((e) => e.episode)).size;
    return {
      first: episodes[0].timestamp_unix,
      last: episodes[episodes.length - 1].timestamp_unix,
      distinct,
      repeats: episodes.length - distinct,
    };
  }, [episodes]);

  return (
    <div className="space-y-4">
      <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-4 flex items-center gap-4">
        <button
          onClick={onBack}
          title="Back to all history"
          className="p-2 rounded-xl hover:bg-bg-tertiary text-text-secondary hover:text-text-primary transition shrink-0"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <button
          disabled={!anime}
          onClick={() => anime && openAnime(anime)}
          className="shrink-0 focus:outline-none disabled:cursor-default"
        >
          <Cover anime={anime} alt={title} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-text-primary truncate">{title}</div>
          <div className="text-[11px] text-text-muted">
            {summary
              ? `${plural(summary.distinct, "episode")}${summary.repeats > 0 ? ` · ${plural(summary.repeats, "rewatched episode")}` : ""} · ${new Date(summary.first * 1000).toLocaleDateString()} – ${new Date(summary.last * 1000).toLocaleDateString()}`
              : episodes
                ? "No watched episodes logged"
                : "Loading..."}
          </div>
        </div>
        <button
          onClick={onBack}
          title="Clear the anime filter"
          className="p-2 rounded-xl hover:bg-bg-tertiary text-text-muted hover:text-text-primary transition shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {groups.map((g) => (
        <section key={g.label} className="bg-bg-secondary border border-border-subtle rounded-2xl p-4 space-y-0.5">
          <h2 className="text-xs font-bold text-text-secondary pb-1">
            {g.label}
            <span className="ml-2 font-medium text-text-muted">{plural(g.items.length, "episode")}</span>
          </h2>
          {g.items.map((e, i) => (
            <div key={`${e.timestamp_unix}-${e.episode}-${i}`} className="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-bg-tertiary">
              <span className="w-16 text-xs font-mono font-semibold text-accent shrink-0">Ep {e.episode}</span>
              <span className="flex-1 min-w-0 text-[11px] text-text-muted font-mono truncate flex items-center gap-1.5">
                {e.source === "anilist" && <AniListBadge />}
                {SOURCE_LABEL[e.source] && e.source !== "anilist" ? SOURCE_LABEL[e.source] : e.source === "player" ? e.player_name : null}
                {e.rewatch && <span className="text-text-secondary">Rewatch</span>}
              </span>
              <span
                className="text-[10px] font-mono text-text-muted shrink-0"
                title={e.batch ? "AniList merged several episodes into one activity: this is the activity's time" : undefined}
              >
                {e.batch ? "≈ " : ""}
                {timeLabel(e.timestamp_unix)}
              </span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
};
