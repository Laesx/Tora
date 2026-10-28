import React, { useCallback, useEffect, useMemo, useState } from "react";
import { History, Search, Undo2 } from "lucide-react";
import { AnimeEntry, MANUAL_HISTORY_PLAYER, WatchHistoryEntry } from "../types";
import { getOptimizedCoverUrl, toraApi } from "../api";
import { useAnimeTitle } from "../titles";

interface HistoryViewProps {
  animeList: AnimeEntry[];
  /** Changes whenever a new history row may exist (scrobble / list update) */
  refreshKey: unknown;
  onOpenAnime: (anime: AnimeEntry) => void;
}

type SourceFilter = "all" | "player" | "manual";

const PAGE_SIZE = 100;

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

/** "3 episodes · 1 correction" for a day group (corrections are not counted as episodes). */
function dayCountLabel(items: WatchHistoryEntry[]): string {
  const corrections = items.filter((h) => h.progress_from !== null).length;
  const episodes = items.length - corrections;
  const parts = [`${episodes} episode${episodes === 1 ? "" : "s"}`];
  if (corrections > 0) parts.push(`${corrections} correction${corrections === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** Every logged episode (media player scrobbles and manual progress changes), newest first.
 *  Manual progress decreases show as correction rows ("Ep 5 → 3"), which are not watched episodes. */
export const HistoryView: React.FC<HistoryViewProps> = ({ animeList, refreshKey, onOpenAnime }) => {
  const titleOf = useAnimeTitle();
  const [rows, setRows] = useState<WatchHistoryEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");

  const load = useCallback(async (offset: number, limit = PAGE_SIZE) => {
    setLoading(true);
    try {
      const page = await toraApi.getWatchHistory(limit, offset);
      setRows((prev) => (offset === 0 ? page : [...prev, ...page]));
      setHasMore(page.length === limit);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(0);
  }, [load, refreshKey]);

  const byId = useMemo(() => new Map(animeList.map((a) => [a.id, a])), [animeList]);

  // Live entries show in the chosen title language; rows of removed anime keep the logged title
  const rowTitle = useCallback(
    (h: WatchHistoryEntry) => {
      const anime = h.anime_id !== null ? byId.get(h.anime_id) : undefined;
      return anime ? titleOf(anime) : h.anime_title;
    },
    [byId, titleOf]
  );

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const out: { label: string; items: WatchHistoryEntry[] }[] = [];
    for (const h of rows) {
      const manual = h.player_name === MANUAL_HISTORY_PLAYER;
      if (source === "manual" && !manual) continue;
      if (source === "player" && manual) continue;
      if (
        needle &&
        !h.anime_title.toLowerCase().includes(needle) &&
        !rowTitle(h).toLowerCase().includes(needle)
      )
        continue;
      const label = dayLabel(h.timestamp_unix);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(h);
      else out.push({ label, items: [h] });
    }
    return out;
  }, [rows, filter, source, rowTitle]);

  return (
    <div className="p-6 space-y-5 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-bold text-text-primary flex items-center gap-2.5">
          <History className="w-6 h-6 text-accent" />
          History
        </h1>
        <div className="flex flex-wrap items-center gap-2">
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
          <div className="flex items-center bg-bg-secondary p-1 rounded-xl border border-border-subtle">
            {(
              [
                ["all", "All"],
                ["player", "Player"],
                ["manual", "Manual"],
              ] as const
            ).map(([id, label]) => (
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
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="bg-bg-secondary border border-border-subtle rounded-2xl py-16 text-center text-xs text-text-muted">
          {rows.length === 0 && !loading
            ? "No history yet. Play an episode or update your progress to start tracking."
            : "No entries match the filter."}
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
                <span className="ml-2 font-medium text-text-muted">
                  {dayCountLabel(g.items)}
                </span>
              </h2>
              {g.items.map((h) => {
                const anime = h.anime_id !== null ? byId.get(h.anime_id) : undefined;
                const manual = h.player_name === MANUAL_HISTORY_PLAYER;
                const correction = h.progress_from !== null;
                return (
                  <button
                    key={h.id}
                    disabled={!anime}
                    onClick={() => anime && onOpenAnime(anime)}
                    className="w-full flex items-center gap-3 p-2 rounded-xl hover:bg-bg-tertiary disabled:hover:bg-transparent text-left transition focus:outline-none"
                  >
                    {anime ? (
                      <img
                        src={getOptimizedCoverUrl(anime.cover_image, "medium")}
                        alt={titleOf(anime)}
                        loading="lazy"
                        decoding="async"
                        className="w-8 h-11 object-cover rounded-md shrink-0"
                      />
                    ) : (
                      <div className="w-8 h-11 rounded-md bg-bg-tertiary shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-text-primary truncate">
                        {rowTitle(h)}{" "}
                        {correction ? (
                          <span className="text-text-muted font-mono">
                            Ep {h.progress_from} → {h.episode_number}
                          </span>
                        ) : (
                          <span className="text-accent font-mono">Ep {h.episode_number}</span>
                        )}
                      </div>
                      <div className="text-[11px] text-text-muted font-mono truncate flex items-center gap-1">
                        {correction ? (
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
                      <span className="text-[10px] font-mono text-text-muted block">
                        {new Date(h.timestamp_unix * 1000).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      {!manual && h.scrobbled_to_tracker && (
                        <span className="text-[10px] text-emerald-400 font-semibold">Synced</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </section>
          ))}
        </div>
      )}

      {hasMore && (
        <div className="flex justify-center">
          <button
            onClick={() => load(rows.length)}
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
