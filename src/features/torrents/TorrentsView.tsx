import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Download, Magnet, RefreshCw, Rss, Search, Settings, SlidersHorizontal, Star, X } from "lucide-react";
import {
  AnimeEntry,
  AnimeReleaseCard,
  BoardOptions,
  BoardRelease,
  BoardSource,
  DownloadRequest,
  FansubOverride,
  PriorityConfig,
  SearchFeed,
  TorrentBoard,
  TorrentFeed,
  TorrentFilter,
} from "@/lib/types";
import { toraApi } from "@/lib/api";
import { displayUrl, fillSearchTemplate, groupQuery, quoteValue, TorrentSearchRequest } from "@/lib/torrents";
import { FloatingQuickMenu } from "@/components/FloatingQuickMenu";
import { ReleaseCard } from "./ReleaseCard";
import { ReleaseMenu, ReleaseMenuAction } from "./ReleaseMenu";
import { FeedsPanel } from "./FeedsPanel";
import { FiltersPanel } from "./FiltersPanel";
import { useToast } from "@/contexts/toast";
import { useAnimeActions } from "@/contexts/animeActions";

interface TorrentsViewProps {
  animeList: AnimeEntry[];
  /** Search handed over from elsewhere (drawer, quick menu, palette); a new `nonce` searches again */
  searchRequest: (TorrentSearchRequest & { nonce: number }) | null;
  onRefreshAnimeList: () => Promise<void> | void;
  /** Opens Settings → Torrents (app, download folder, refresh interval) */
  onOpenSettings: () => void;
}

type SubTab = "releases" | "feeds" | "filters";

// View state kept for the session while the tab is unmounted (the feed data itself is cached in the backend).
const memory = {
  subTab: "releases" as SubTab,
  /** Ticked feeds; null = every enabled feed */
  feedIds: null as number[] | null,
  search: null as TorrentSearchRequest | null,
  lastNonce: 0,
  showDiscarded: false,
  showUnmatched: false,
  /** Checkbox changes the user made, by release key (otherwise the auto-selection applies) */
  manual: new Map<string, boolean>(),
  /** Last board and the source it was built for, shown at once when the tab mounts again */
  board: null as { key: string; board: TorrentBoard } | null,
};

const sourceFor = (search: TorrentSearchRequest | null, feedIds: number[] | null): BoardSource =>
  search ? { search: search.query, anime_id: search.animeId } : { feed_ids: feedIds };

const sourceKey = (source: BoardSource) => JSON.stringify(source);

const chipClass = (active: boolean) =>
  `px-2.5 py-1 rounded-lg text-[11px] font-medium border transition flex items-center gap-1.5 ${active
    ? "bg-accent/20 border-accent/60 text-accent"
    : "bg-bg-primary border-border-subtle text-text-secondary hover:text-text-primary"
  }`;

function updatedLabel(fetchedAt: number | null, now: number): string {
  if (!fetchedAt) return "Not fetched yet";
  const s = Math.max(0, now - fetchedAt);
  if (s < 60) return "Updated just now";
  if (s < 3600) return `Updated ${Math.round(s / 60)} min ago`;
  return `Updated ${Math.round(s / 3600)} h ago`;
}

const toRequest = (r: BoardRelease, card: AnimeReleaseCard): DownloadRequest => ({
  key: r.key,
  title: r.title,
  torrent_url: r.torrent_url,
  magnet_url: r.magnet_url,
  anime_id: card.anime_id,
  parsed_title: r.parsed_title,
});

export const TorrentsView: React.FC<TorrentsViewProps> = ({
  animeList,
  searchRequest,
  onRefreshAnimeList,
  onOpenSettings,
}) => {
  const { openAnime } = useAnimeActions();
  const showToast = useToast();
  const [subTab, setSubTabState] = useState<SubTab>(memory.subTab);
  const [feedIds, setFeedIdsState] = useState<number[] | null>(memory.feedIds);
  const [search, setSearchState] = useState<TorrentSearchRequest | null>(() => {
    if (searchRequest && searchRequest.nonce !== memory.lastNonce) {
      memory.lastNonce = searchRequest.nonce;
      memory.search = { query: searchRequest.query, animeId: searchRequest.animeId };
      memory.subTab = "releases";
    }
    return memory.search;
  });
  const [searchText, setSearchText] = useState(search?.query ?? "");
  const [showDiscarded, setShowDiscarded] = useState(memory.showDiscarded);
  const [showUnmatched, setShowUnmatched] = useState(memory.showUnmatched);
  const [manual, setManualState] = useState(memory.manual);

  const [board, setBoardState] = useState<TorrentBoard | null>(() =>
    memory.board?.key === sourceKey(sourceFor(memory.search, memory.feedIds)) ? memory.board.board : null
  );
  const [loading, setLoading] = useState(false);
  /** A network fetch is running (Refresh or a search), not just a re-read of the cache */
  const [fetching, setFetching] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [now, setNow] = useState(() => Date.now() / 1000);

  const [feeds, setFeeds] = useState<TorrentFeed[]>([]);
  const [searchFeeds, setSearchFeeds] = useState<SearchFeed[]>([]);
  const [filters, setFilters] = useState<TorrentFilter[]>([]);
  const [priority, setPriority] = useState<PriorityConfig>({ tiers: [], fallback_to_best: true });
  const [fansubs, setFansubs] = useState<FansubOverride[]>([]);
  const [boardOptions, setBoardOptions] = useState<BoardOptions>({ hidden_statuses: [], search_feed_id: null });
  const [pendingFilter, setPendingFilter] = useState<TorrentFilter | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; release: BoardRelease; card: AnimeReleaseCard } | null>(null);

  const setSubTab = (t: SubTab) => {
    memory.subTab = t;
    setSubTabState(t);
  };
  const setFeedIds = (ids: number[] | null) => {
    memory.feedIds = ids;
    setFeedIdsState(ids);
  };
  const setSearch = (s: TorrentSearchRequest | null) => {
    memory.search = s;
    setSearchState(s);
    setSearchText(s?.query ?? "");
  };
  const setManual = (m: Map<string, boolean>) => {
    memory.manual = m;
    setManualState(m);
  };

  const animeById = useMemo(() => new Map(animeList.map((a) => [a.id, a])), [animeList]);
  const seqRef = useRef(0);
  const inFlightPromiseRef = useRef<Map<string, Promise<TorrentBoard>>>(new Map());
  // Reads never fetch general feeds (only Refresh does); a search fetches when it isn't cached yet.
  const load = useCallback(
    async (force = false, quiet = false) => {
      const source = sourceFor(search, feedIds);
      const key = sourceKey(source);
      const seq = ++seqRef.current;
      if (!quiet) {
        setLoading(true);
        setFetching(force || !!search);
      }
      const promise = (!force && inFlightPromiseRef.current.get(key)) || toraApi.getTorrentBoard(source, force);
      if (!force) {
        inFlightPromiseRef.current.set(key, promise);
      }
      try {
        const b = await promise;
        if (seq !== seqRef.current) return;
        memory.board = { key, board: b };
        setBoardState(b);
        if (force && b.errors.length) showToast(b.errors.join(" · "), "error");
      } catch (e) {
        if (seq === seqRef.current) showToast(String(e), "error");
      } finally {
        if (!force && inFlightPromiseRef.current.get(key) === promise) {
          inFlightPromiseRef.current.delete(key);
        }
        if (seq === seqRef.current) {
          setLoading(false);
          setFetching(false);
        }
      }
    },
    [search, feedIds, showToast]
  );
  const loadRef = useRef(load);
  loadRef.current = load;

  const loadConfig = useCallback(async () => {
    try {
      const [fd, sf, fl, pr, fs, bo] = await Promise.all([
        toraApi.getTorrentFeeds(),
        toraApi.getTorrentSearchFeeds(),
        toraApi.getTorrentFilters(),
        toraApi.getTorrentPriority(),
        toraApi.getTorrentFansubs(),
        toraApi.getTorrentBoardOptions(),
      ]);
      setFeeds(fd);
      setSearchFeeds(sf);
      setFilters(fl);
      setPriority(pr);
      setFansubs(fs);
      setBoardOptions(bo);
    } catch (e) {
      showToast(String(e), "error");
    }
  }, [showToast]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    // A remembered board is already on screen: re-read the cache quietly (selection may have changed)
    void load(false, board !== null);
  }, [load]);

  // A new hand-over while this tab is already open
  useEffect(() => {
    if (!searchRequest || searchRequest.nonce === memory.lastNonce) return;
    memory.lastNonce = searchRequest.nonce;
    setSubTab("releases");
    setSearch({ query: searchRequest.query, animeId: searchRequest.animeId });
  }, [searchRequest]);

  // List changes (progress, new files) only re-run selection on the cached feeds
  const prevAnimeListRef = useRef(animeList);
  useEffect(() => {
    if (prevAnimeListRef.current === animeList) return;
    prevAnimeListRef.current = animeList;
    const t = setTimeout(() => void loadRef.current(false, true), 400);
    return () => clearTimeout(t);
  }, [animeList]);

  useEffect(() => {
    let off: (() => void) | undefined;
    let disposed = false;
    listen("torrent-feeds-refreshed", () => {
      if (!memory.search) void loadRef.current(false, true);
    }).then((u) => (disposed ? u() : (off = u)));
    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 30_000);
    return () => clearInterval(t);
  }, []);

  const isChecked = useCallback((r: BoardRelease) => manual.get(r.key) ?? r.selected, [manual]);

  const toggle = (keys: string[], checked: boolean) => {
    const next = new Map(manual);
    keys.forEach((k) => next.set(k, checked));
    setManual(next);
  };

  const visibleCards = useMemo(() => {
    if (!board) return [];
    return board.cards.filter((c) => {
      if (c.anime_id == null && !showUnmatched) return false;
      const isFocus = search?.animeId != null && c.anime_id === search.animeId;
      return isFocus || c.releases.some((r) => showDiscarded || !r.discarded_by);
    });
  }, [board, showUnmatched, showDiscarded, search]);

  const checkedReleases = useMemo(() => {
    const out: { r: BoardRelease; card: AnimeReleaseCard }[] = [];
    for (const card of board?.cards ?? []) {
      if (card.anime_id == null && !showUnmatched) continue;
      for (const r of card.releases) {
        if (r.discarded_by && !showDiscarded) continue;
        if (isChecked(r)) out.push({ r, card });
      }
    }
    return out;
  }, [board, isChecked, showUnmatched, showDiscarded]);

  const unmatchedCount = board?.cards.filter((c) => c.anime_id == null).length ?? 0;

  const download = async (items: { r: BoardRelease; card: AnimeReleaseCard }[]) => {
    if (items.length === 0) return;
    setDownloading(true);
    try {
      const summary = await toraApi.downloadReleases(items.map(({ r, card }) => toRequest(r, card)));
      const ok = summary.results.filter((x) => x.ok);
      const failed = summary.results.filter((x) => !x.ok);
      if (ok.length) {
        showToast(`Sent ${ok.length} torrent${ok.length === 1 ? "" : "s"} to ${summary.app.label}`, "success");
      }
      if (failed.length) showToast(failed.map((f) => f.message).join(" · "), "error");
      const next = new Map(manual);
      ok.forEach((x) => next.delete(x.key));
      setManual(next);
      if (summary.bound_anime_ids.length) await onRefreshAnimeList();
      await load(false, true);
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setDownloading(false);
    }
  };

  const saveFansubs = async (animeId: number, groups: string[]) => {
    try {
      setFansubs(await toraApi.setAnimeFansubs(animeId, groups));
      await load(false, true);
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  const savePriority = async (p: PriorityConfig) => {
    try {
      setPriority(await toraApi.saveTorrentPriority(p));
      await load(false, true);
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  const saveFilters = async (f: TorrentFilter[]) => {
    try {
      setFilters(await toraApi.saveTorrentFilters(f));
      await load(false, true);
      showToast("Filters saved", "success");
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  const saveBoardOptions = async (o: BoardOptions) => {
    setBoardOptions(o);
    try {
      setBoardOptions(await toraApi.saveTorrentBoardOptions(o));
      await load(false, true);
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  // The backend searches with the stored choice, so save it before reloading
  const activeSearchFeed =
    searchFeeds.find((f) => f.id === boardOptions.search_feed_id) ?? searchFeeds[0] ?? null;

  const chooseSearchFeed = async (id: number) => {
    await saveBoardOptions({ ...boardOptions, search_feed_id: id });
  };

  const saveSearchFeeds = async (f: SearchFeed[]) => {
    try {
      setSearchFeeds(await toraApi.saveTorrentSearchFeeds(f));
      showToast("Search feeds saved", "success");
      if (search) await load(false, true);
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  const saveFeeds = async (f: TorrentFeed[]) => {
    try {
      const saved = await toraApi.saveTorrentFeeds(f);
      setFeeds(saved);
      if (feedIds) setFeedIds(feedIds.filter((id) => saved.some((x) => x.id === id)));
      showToast("Feeds saved", "success");
      if (!search) await load(false, true);
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  const groupTierIndex = (group: string | null) => {
    if (!group) return null;
    const q = groupQuery(group).toLowerCase();
    const i = priority.tiers.findIndex((t) => t.query.trim().toLowerCase() === q);
    return i < 0 ? null : i;
  };

  const handleMenu = async (action: ReleaseMenuAction) => {
    if (!menu) return;
    const { release: r, card } = menu;
    setMenu(null);
    const override = card.fansub_override ?? [];
    switch (action.kind) {
      case "download":
        return download([{ r, card }]);
      case "copy-magnet":
        await navigator.clipboard.writeText(r.magnet_url);
        return showToast("Copied magnet link", "info");
      case "copy-title":
        await navigator.clipboard.writeText(r.title);
        return showToast("Copied release name", "info");
      case "open-page":
        return toraApi.openExternalUrl(r.view_url).catch((e) => showToast(String(e), "error"));
      case "only-group":
        await saveFansubs(card.anime_id!, [action.group]);
        return showToast(`Only ${action.group} will be picked for this anime`, "success");
      case "add-group":
        return saveFansubs(card.anime_id!, [...override, action.group]);
      case "remove-group":
        return saveFansubs(card.anime_id!, override.filter((g) => g.toLowerCase() !== action.group.toLowerCase()));
      case "clear-override":
        return saveFansubs(card.anime_id!, []);
      case "top-priority": {
        const q = groupQuery(action.group);
        const rest = priority.tiers.filter((t) => t.query.trim().toLowerCase() !== q.toLowerCase());
        const existing = priority.tiers.find((t) => t.query.trim().toLowerCase() === q.toLowerCase());
        await savePriority({ ...priority, tiers: [existing ?? { id: 0, query: q, enabled: true }, ...rest] });
        return showToast(`${action.group} is now the top priority`, "success");
      }
      case "discard-group":
        await saveFilters([
          ...filters,
          { id: 0, name: `Hide ${action.group}`, enabled: true, action: "discard", query: groupQuery(action.group), anime_ids: [] },
        ]);
        return;
      case "create-filter": {
        const parts: string[] = [];
        if (r.group) parts.push(groupQuery(r.group));
        if (r.traits.resolution) parts.push(`res:${r.traits.resolution}`);
        if (r.traits.codec) parts.push(`codec:${r.traits.codec}`);
        if (!r.group && r.parsed_title) parts.push(`title:${quoteValue(r.parsed_title)}`);
        setPendingFilter({
          id: 0,
          name: r.group ? `${r.group} releases` : "New filter",
          enabled: true,
          action: "discard",
          query: parts.join(" "),
          anime_ids: card.anime_id != null ? [card.anime_id] : [],
        });
        return setSubTab("filters");
      }
      case "open-anime": {
        const a = card.anime_id != null ? animeById.get(card.anime_id) : undefined;
        if (a) openAnime(a);
        return;
      }
    }
  };

  const enabledFeeds = feeds.filter((f) => f.enabled);
  const allFeedsActive = !search && feedIds === null;
  const feedActive = (id: number) => !search && feedIds !== null && feedIds.includes(id);
  const toggleFeed = (id: number) => {
    setSearch(null);
    const current = feedIds ?? [];
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    setFeedIds(next.length ? next : null);
  };

  const runSearch = () => {
    const q = searchText.trim();
    if (!q) {
      setSearch(null);
      return;
    }
    setSearch({ query: q, animeId: search && search.query === q ? search.animeId : null });
  };

  const saveSearchAsFeed = async () => {
    if (!search) return;
    if (!activeSearchFeed) return;
    await saveFeeds([
      ...feeds,
      { id: 0, name: search.query, enabled: true, url: fillSearchTemplate(activeSearchFeed.url, search.query) },
    ]);
  };

  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-bold text-text-primary flex items-center gap-2.5">
          <Magnet className="w-6 h-6 text-accent" />
          Torrents
        </h1>
        <div className="flex items-center gap-1.5 bg-bg-secondary p-1 rounded-xl border border-border-subtle">
          {(
            [
              ["releases", "Releases", Download],
              ["feeds", `Feeds (${feeds.length})`, Rss],
              ["filters", "Filters & priority", SlidersHorizontal],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => setSubTab(id)}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 ${subTab === id ? "bg-accent text-white" : "text-text-secondary hover:text-text-primary"
                }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
          <button
            onClick={onOpenSettings}
            className="px-2.5 py-1.5 rounded-lg text-text-secondary hover:text-text-primary transition"
            title="Torrent settings (app, download folder, refresh interval)"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {subTab === "releases" && (
        <>
          <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  runSearch();
                }}
                className="relative flex-1 min-w-[240px]"
              >
                <Search className="w-4 h-4 text-text-muted absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder="Search for an anime (Enter)…"
                  className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-bg-primary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent"
                />
              </form>
              {searchFeeds.length > 0 && (
                <select
                  value={activeSearchFeed?.id ?? ""}
                  onChange={(e) => void chooseSearchFeed(Number(e.target.value))}
                  title="Search feed used for searches"
                  className="px-3 py-2.5 rounded-xl bg-bg-primary border border-border-subtle text-xs text-text-primary max-w-[220px]"
                >
                  {searchFeeds.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              )}
              <button
                onClick={() => void load(true)}
                disabled={loading}
                className="px-4 py-2.5 rounded-xl bg-bg-primary border border-border-subtle hover:bg-bg-tertiary text-text-primary text-xs font-semibold transition flex items-center gap-1.5"
                title="Fetch the feeds again"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </button>
              <span className="text-[11px] text-text-muted">{updatedLabel(board?.fetched_at ?? null, now)}</span>
              <button
                onClick={() => void download(checkedReleases)}
                disabled={downloading || checkedReleases.length === 0}
                className="ml-auto px-4 py-2.5 rounded-xl bg-accent hover:bg-accent-hover disabled:opacity-40 text-white text-xs font-semibold transition flex items-center gap-1.5"
              >
                <Download className="w-3.5 h-3.5" />
                {downloading ? "Sending…" : `Download selected (${checkedReleases.length})`}
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {search ? (
                <>
                  <span className={chipClass(true)}>
                    <Search className="w-3 h-3" />
                    Search: {search.query}
                    <button onClick={() => setSearch(null)} className="hover:text-text-primary" title="Back to feeds">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                  <button onClick={() => void saveSearchAsFeed()} className={chipClass(false)}>
                    <Star className="w-3 h-3" /> Save as feed
                  </button>
                </>
              ) : (
                <button onClick={() => setFeedIds(null)} className={chipClass(allFeedsActive)}>
                  All feeds ({enabledFeeds.length})
                </button>
              )}
              {feeds.map((f) => (
                <button key={f.id} onClick={() => toggleFeed(f.id)} className={chipClass(feedActive(f.id))} title={displayUrl(f.url)}>
                  <Rss className="w-3 h-3" />
                  {f.name}
                  {!f.enabled && <span className="text-text-muted">(off)</span>}
                </button>
              ))}
              <span className="ml-auto flex items-center gap-1.5">
                <button
                  onClick={() => {
                    memory.showUnmatched = !showUnmatched;
                    setShowUnmatched(!showUnmatched);
                  }}
                  className={chipClass(showUnmatched)}
                >
                  Not in my list ({unmatchedCount})
                </button>
                <button
                  onClick={() => {
                    memory.showDiscarded = !showDiscarded;
                    setShowDiscarded(!showDiscarded);
                  }}
                  className={chipClass(showDiscarded)}
                >
                  Show hidden
                </button>
              </span>
            </div>
          </div>

          {board?.errors.length ? (
            <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-xs text-red-300">
              {board.errors.join(" · ")}
            </div>
          ) : null}

          {!search && board && board.unfetched.length > 0 && board.fetched_at != null && (
            <div className="text-[11px] text-text-muted px-1">
              {board.unfetched.join(", ")} not fetched yet. Press Refresh to fetch {board.unfetched.length === 1 ? "it" : "them"}.
            </div>
          )}

          {!board ? (
            fetching ? (
              <div className="py-16 text-center text-xs text-text-muted flex flex-col items-center gap-2">
                <RefreshCw className="w-6 h-6 text-accent animate-spin" />
                {search ? "Searching…" : "Fetching feeds…"}
              </div>
            ) : null
          ) : !search && board.fetched_at == null ? (
            <div className="bg-bg-secondary border border-border-subtle rounded-2xl py-14 text-center text-xs text-text-muted flex flex-col items-center gap-3">
              {board.unfetched.length > 0 ? (
                <>
                  Feeds aren't fetched yet.
                  <button
                    onClick={() => void load(true)}
                    disabled={loading}
                    className="px-4 py-2 rounded-xl bg-accent hover:bg-accent-hover disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-1.5"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${fetching ? "animate-spin" : ""}`} />
                    {fetching ? "Fetching…" : "Refresh"}
                  </button>
                </>
              ) : (
                "No feeds selected. Add one on the Feeds tab."
              )}
            </div>
          ) : visibleCards.length === 0 ? (
            <div className="bg-bg-secondary border border-border-subtle rounded-2xl py-14 text-center text-xs text-text-muted">
              {search ? "No releases found for this search." : "No releases for anime in your list in these feeds."}
              {unmatchedCount > 0 && !showUnmatched && " Turn on “Not in my list” to see the rest."}
            </div>
          ) : (
            <div className={`space-y-3 transition-opacity ${loading ? "opacity-60" : ""}`}>
              {visibleCards.map((card) => (
                <ReleaseCard
                  key={card.key}
                  card={card}
                  entry={card.anime_id != null ? animeById.get(card.anime_id) : undefined}
                  tierLabels={board?.tier_labels ?? []}
                  showDiscarded={showDiscarded}
                  isChecked={isChecked}
                  onToggle={toggle}
                  onContextMenu={(e, release, c) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, release, card: c });
                  }}
                />
              ))}
            </div>
          )}
        </>
      )}

      {subTab === "feeds" && (
        <FeedsPanel
          feeds={feeds}
          searchFeeds={searchFeeds}
          onSave={saveFeeds}
          onSaveSearchFeeds={saveSearchFeeds}
          onOpenSettings={onOpenSettings}
        />
      )}

      {subTab === "filters" && (
        <FiltersPanel
          animeList={animeList}
          priority={priority}
          filters={filters}
          fansubs={fansubs}
          boardOptions={boardOptions}
          onSaveBoardOptions={saveBoardOptions}
          groups={board?.groups ?? []}
          onSavePriority={savePriority}
          onSaveFilters={saveFilters}
          onSetFansubs={saveFansubs}
          pendingFilter={pendingFilter}
          onPendingConsumed={() => setPendingFilter(null)}
        />
      )}

      {menu && (
        <FloatingQuickMenu anchor={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)}>
          <ReleaseMenu
            release={menu.release}
            card={menu.card}
            groupTierIndex={groupTierIndex(menu.release.group)}
            onAction={(a) => void handleMenu(a)}
          />
        </FloatingQuickMenu>
      )}
    </div>
  );
};
