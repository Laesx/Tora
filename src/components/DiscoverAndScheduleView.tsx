import React, { useEffect, useMemo, useState } from "react";
import {
  Compass,
  Calendar,
  Search,
  Plus,
  Check,
  Star,
  Clock,
  RefreshCw,
} from "lucide-react";
import { AnimeEntry } from "../types";
import { formatCountdown, getOptimizedCoverUrl, toraApi } from "../api";

interface DiscoverAndScheduleViewProps {
  animeList: AnimeEntry[];
  onRefreshAnimeList: (updatedList?: AnimeEntry[]) => Promise<void>;
  onSelectAnime: (anime: AnimeEntry) => void;
  showToast: (msg: string, type?: "success" | "info" | "error") => void;
}

export const DiscoverAndScheduleView: React.FC<
  DiscoverAndScheduleViewProps
> = ({ animeList, onRefreshAnimeList, onSelectAnime, showToast }) => {
  const [query, setQuery] = useState("");
  const [season, setSeason] = useState("FALL");
  const [year, setYear] = useState(2024);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<AnimeEntry[]>([]);

  const airingInWatchlist = useMemo(() => {
    return animeList
      .filter((a) => a.next_airing_at && a.next_airing_episode)
      .sort((a, b) => (a.next_airing_at || 0) - (b.next_airing_at || 0));
  }, [animeList]);

  const fetchDiscover = async (q = query, s = season, y = year) => {
    setLoading(true);
    try {
      const items = await toraApi.searchRemoteAnime({
        query: q,
        season: q.trim() ? null : s,
        year: q.trim() ? null : y,
      });
      setResults(items);
    } catch (err: any) {
      showToast(String(err), "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDiscover("", season, year);
  }, []);

  const handleAddAnime = async (entry: AnimeEntry, status: string) => {
    const optimisticEntry: AnimeEntry = {
      ...entry,
      user_status: status,
      updated_at: Math.floor(Date.now() / 1000),
    };

    // Instant 0ms optimistic UI update so the card button immediately turns to "In Watchlist"
    await onRefreshAnimeList([
      ...animeList.filter((a) => a.id !== entry.id),
      optimisticEntry,
    ]);
    showToast(
      `Added "${entry.title_romaji}" to ${
        status === "CURRENT" ? "Watching" : "Plan to Watch"
      }`,
      "success"
    );

    try {
      const updated = await toraApi.addOrUpsertAnime(optimisticEntry);
      await onRefreshAnimeList(updated);
    } catch (err: any) {
      showToast(String(err), "error");
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Airing Schedule Section */}
      {airingInWatchlist.length > 0 && (
        <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-3">
          <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
            <Calendar className="w-4 h-4 text-accent" />
            Upcoming Airing Countdown (Your Watchlist)
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {airingInWatchlist.map((a) => {
              const cd = formatCountdown(a.next_airing_at);
              const behind = Math.max(
                0,
                (a.next_airing_episode || 1) - 1 - a.user_progress
              );
              return (
                <div
                  key={a.id}
                  onClick={() => onSelectAnime(a)}
                  className="flex items-center gap-3 p-3 rounded-xl bg-bg-primary border border-border-subtle hover:border-accent/60 cursor-pointer transition"
                >
                  <img
                    src={getOptimizedCoverUrl(a.cover_image, "medium")}
                    alt={a.title_romaji}
                    loading="lazy"
                    decoding="async"
                    className="w-12 h-16 object-cover rounded-lg shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold text-text-primary truncate">
                      {a.title_romaji}
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 text-[11px] font-mono font-semibold flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        Ep {a.next_airing_episode} in {cd}
                      </span>
                    </div>
                    <div className="text-[10px] text-text-muted mt-1">
                      Progress: {a.user_progress} / {a.episodes ?? "?"}
                      {behind > 0 ? ` (${behind} ep behind)` : " (Caught up!)"}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Seasonal & AniList Search Bar */}
      <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold text-text-primary flex items-center gap-2">
              <Compass className="w-5 h-5 text-accent" />
              Discover & Seasonal Anime Browser (AniList Plugin)
            </h1>
            <p className="text-xs text-text-secondary">
              Search any anime on AniList or browse seasonal charts and add directly to your local library.
            </p>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            fetchDiscover(query, season, year);
          }}
          className="flex flex-wrap items-center gap-2.5"
        >
          <div className="relative flex-1 min-w-[240px]">
            <Search className="w-4 h-4 text-text-muted absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search any anime on AniList (e.g. Steins;Gate,Solo Leveling, Bleach)..."
              className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-bg-primary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent"
            />
          </div>

          <select
            value={season}
            onChange={(e) => {
              setSeason(e.target.value);
              setQuery("");
              fetchDiscover("", e.target.value, year);
            }}
            className="px-3 py-2.5 rounded-xl bg-bg-primary border border-border-subtle text-xs text-text-primary"
          >
            <option value="WINTER">Winter</option>
            <option value="SPRING">Spring</option>
            <option value="SUMMER">Summer</option>
            <option value="FALL">Fall</option>
          </select>

          <select
            value={year}
            onChange={(e) => {
              const y = Number(e.target.value);
              setYear(y);
              setQuery("");
              fetchDiscover("", season, y);
            }}
            className="px-3 py-2.5 rounded-xl bg-bg-primary border border-border-subtle text-xs text-text-primary font-mono"
          >
            {[2026, 2025, 2024, 2023, 2022, 2021, 2020].map((yr) => (
              <option key={yr} value={yr}>
                {yr}
              </option>
            ))}
          </select>

          <button
            type="submit"
            disabled={loading}
            className="px-5 py-2.5 rounded-xl bg-accent hover:bg-accent-hover text-white text-xs font-semibold transition flex items-center gap-1.5"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
            />
            {loading ? "Loading..." : "Search AniList"}
          </button>
        </form>

        {/* Results Grid */}
        {loading ? (
          <div className="py-16 text-center text-xs text-text-muted flex flex-col items-center gap-2">
            <RefreshCw className="w-6 h-6 text-accent animate-spin" />
            <span>Querying AniList GraphQL API...</span>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 pt-2">
            {results.map((item) => {
              const existing = animeList.find((a) => a.id === item.id);
              return (
                <div
                  key={item.id}
                  className="group bg-bg-primary border border-border-subtle rounded-xl overflow-hidden flex flex-col hover:border-accent/60 transition shadow-sm"
                >
                  <div className="relative aspect-[3/4] w-full bg-bg-tertiary overflow-hidden">
                    <img
                      src={getOptimizedCoverUrl(item.cover_image, "large")}
                      alt={item.title_romaji}
                      loading="lazy"
                      decoding="async"
                      className="w-full h-full object-cover"
                    />
                    {item.average_score && (
                      <span className="absolute top-2 right-2 px-2 py-0.5 rounded-md bg-black/75 backdrop-blur-sm text-amber-400 text-[11px] font-bold flex items-center gap-1">
                        <Star className="w-3 h-3 fill-amber-400" />
                        {item.average_score}%
                      </span>
                    )}
                    <span className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-black/75 text-white text-[10px] font-semibold">
                      {item.format} • {item.episodes ?? "?"} eps
                    </span>
                  </div>

                  <div className="p-3 flex-1 flex flex-col justify-between space-y-2">
                    <div>
                      <h3
                        className="text-xs font-bold text-text-primary line-clamp-2"
                        title={item.title_romaji}
                      >
                        {item.title_romaji}
                      </h3>
                      <p className="text-[10px] text-text-muted mt-0.5 truncate">
                        {item.studios.join(", ") || item.genres.slice(0, 2).join(", ")}
                      </p>
                    </div>

                    {existing ? (
                      <button
                        onClick={() => onSelectAnime(existing)}
                        className="w-full py-1.5 rounded-lg bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 text-[11px] font-semibold flex items-center justify-center gap-1"
                      >
                        <Check className="w-3.5 h-3.5" />
                        In Watchlist ({existing.user_status})
                      </button>
                    ) : (
                      <div className="grid grid-cols-2 gap-1.5">
                        <button
                          onClick={() => handleAddAnime(item, "CURRENT")}
                          className="py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-[10px] font-semibold flex items-center justify-center gap-1 transition"
                        >
                          <Plus className="w-3 h-3" />
                          Watching
                        </button>
                        <button
                          onClick={() => handleAddAnime(item, "PLANNING")}
                          className="py-1.5 rounded-lg bg-bg-tertiary hover:bg-bg-elevated text-text-secondary hover:text-text-primary text-[10px] font-medium transition"
                        >
                          + Plan
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
