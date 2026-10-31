import React, { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { AnimeEntry } from "@/lib/types";
import { toraApi } from "@/lib/api";
import { AnimePosterCard } from "@/components/AnimePosterCard";
import { useToast } from "@/contexts/toast";
import { useAnimeActions } from "@/contexts/animeActions";
import { useNavCapture } from "@/app/navigation";

/**
 * Query handed over from another view (e.g. Enter in the Seasons filter), searched when it arrives
 * or the tab mounts again; Back also restores the results it had (`cache`), without a request.
 */
export interface SearchRequest {
  query: string;
  cache?: { results: AnimeEntry[]; searched: string };
  nonce: number;
}

interface SearchViewProps {
  animeList: AnimeEntry[];
  request: SearchRequest | null;
}

export const SearchView: React.FC<SearchViewProps> = ({ animeList, request }) => {
  const { addAnime, openAnime } = useAnimeActions();
  const showToast = useToast();
  const [query, setQuery] = useState(request?.query ?? "");
  const [searched, setSearched] = useState(request?.cache?.searched ?? "");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<AnimeEntry[]>(request?.cache?.results ?? []);
  const requestIdRef = useRef(0);

  const listById = useMemo(
    () => new Map(animeList.map((a) => [a.id, a])),
    [animeList]
  );

  const runSearch = async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const items = await toraApi.searchRemoteAnime({ query: trimmed });
      if (requestId !== requestIdRef.current) return;
      setResults(items);
      setSearched(trimmed);
    } catch (err: any) {
      if (requestId === requestIdRef.current) showToast(String(err), "error");
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!request) return;
    setQuery(request.query);
    if (request.cache) {
      ++requestIdRef.current;
      setLoading(false);
      setResults(request.cache.results);
      setSearched(request.cache.searched);
    } else runSearch(request.query);
  }, [request?.nonce]);

  useNavCapture("search", () => ({
    view: { tab: "search", query },
    cache: searched ? { tab: "search", results, searched } : undefined,
  }));

  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto">
      <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-4">
        <h1 className="text-lg font-bold text-text-primary flex items-center gap-2">
          <Search className="w-5 h-5 text-accent" />
          Search
        </h1>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            runSearch(query);
          }}
          className="flex flex-wrap items-center gap-2.5"
        >
          <div className="relative flex-1 min-w-[240px]">
            <Search className="w-4 h-4 text-text-muted absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search AniList..."
              className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-bg-primary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className="px-5 py-2.5 rounded-xl bg-accent hover:bg-accent-hover text-white text-xs font-semibold transition flex items-center gap-1.5 disabled:opacity-60"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            {loading ? "Searching..." : "Search"}
          </button>
        </form>

        {loading && results.length === 0 ? (
          <div className="py-16 text-center text-xs text-text-muted flex flex-col items-center gap-2">
            <RefreshCw className="w-6 h-6 text-accent animate-spin" />
            <span>Loading...</span>
          </div>
        ) : searched && results.length === 0 ? (
          <div className="py-16 text-center text-xs text-text-muted">
            No results for "{searched}".
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 pt-2">
            {results.map((item) => (
              <AnimePosterCard
                key={item.id}
                anime={item}
                listEntry={listById.get(item.id)}
                onOpen={openAnime}
                onAdd={addAnime}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
