import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
} from "lucide-react";
import { AnimeEntry, CachedSeason, SeasonalAnime, SeasonResult } from "@/lib/types";
import { toraApi } from "@/lib/api";
import {
  FIRST_SEASON_YEAR,
  SEASONS,
  SeasonKey,
  compareSeasons,
  currentSeason,
  sameSeason,
  seasonId,
  seasonLabel,
  seasonName,
  shiftSeason,
} from "@/lib/seasons";
import { AnimePosterCard, POSTER_CARD_FOOTER_HEIGHT } from "@/components/AnimePosterCard";
import { SeasonAnimeMenu } from "@/components/SeasonAnimeMenu";
import { useAnimeTitle } from "@/contexts/titles";
import { useToast } from "@/contexts/toast";
import { useAnimeActions } from "@/contexts/animeActions";
import { usePrefs } from "@/hooks/usePrefs";
import { useScrollViewport, visibleRange } from "@/hooks/virtual";

interface SeasonsViewProps {
  animeList: AnimeEntry[];
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  /** ←/→ switch seasons only while nothing else (drawer, palette) has focus */
  keyboardEnabled: boolean;
  onGlobalSearch: (query: string) => void;
  /** Jump to this season (re-applied whenever the nonce changes) */
  seasonRequest?: SeasonRequest | null;
  onSeasonRequestHandled?: () => void;
}

export type SeasonRequest = SeasonKey & { nonce: number };

type SortKey = "popularity" | "start" | "score" | "title";
type SortDir = "asc" | "desc";
type GroupBy = "none" | "status";

const SORT_OPTIONS: { id: SortKey; label: string; defaultDir: SortDir }[] = [
  { id: "popularity", label: "Popularity", defaultDir: "desc" },
  { id: "start", label: "Airing date", defaultDir: "asc" },
  { id: "score", label: "Score", defaultDir: "desc" },
  { id: "title", label: "Title", defaultDir: "asc" },
];

const FORMATS: { id: string; label: string }[] = [
  { id: "TV", label: "TV" },
  { id: "TV_SHORT", label: "TV Short" },
  { id: "ONA", label: "ONA" },
  { id: "MOVIE", label: "Movie" },
  { id: "OVA", label: "OVA" },
  { id: "SPECIAL", label: "Special" },
  { id: "MUSIC", label: "Music" },
];
const DEFAULT_FORMATS = ["TV", "TV_SHORT", "ONA", "MOVIE"];

// Group order; REPEATING is folded into "Watching"
const STATUS_GROUPS: { id: string; label: string; statuses: string[]; dot: string }[] = [
  { id: "watching", label: "Watching", statuses: ["CURRENT", "REPEATING"], dot: "bg-accent" },
  { id: "planning", label: "Planning", statuses: ["PLANNING"], dot: "bg-sky-500" },
  { id: "completed", label: "Completed", statuses: ["COMPLETED"], dot: "bg-emerald-500" },
  { id: "paused", label: "Paused", statuses: ["PAUSED"], dot: "bg-amber-500" },
  { id: "dropped", label: "Dropped", statuses: ["DROPPED"], dot: "bg-rose-500" },
  { id: "none", label: "Not on list", statuses: [], dot: "bg-text-muted" },
];

const PREFS_KEY = "tora.seasons.prefs";
const HEADER_ROW_HEIGHT = 44;
const GRID_GAP = 16;

interface SeasonPrefs {
  sortKey: SortKey;
  sortDir: SortDir;
  groupBy: GroupBy;
  formats: string[];
}

const DEFAULT_PREFS: SeasonPrefs = {
  sortKey: "popularity",
  sortDir: "desc",
  groupBy: "status",
  formats: DEFAULT_FORMATS,
};

function formatUpdated(fetchedAt: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - fetchedAt);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return new Date(fetchedAt * 1000).toLocaleDateString();
}

function matchesFilter(item: SeasonalAnime, needle: string): boolean {
  if (!needle) return true;
  const fields = [
    item.title_romaji,
    item.title_english,
    item.title_native,
    ...item.synonyms,
  ];
  return fields.some((f) => f && f.toLowerCase().includes(needle));
}

function compareItems(
  a: SeasonalAnime,
  b: SeasonalAnime,
  key: SortKey,
  dir: SortDir,
  titleOf: (m: SeasonalAnime) => string
): number {
  const sign = dir === "asc" ? 1 : -1;
  // Missing values always sort last, whatever the direction
  const nullsLast = <T,>(x: T | null | undefined, y: T | null | undefined, cmp: (x: T, y: T) => number) => {
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return sign * cmp(x, y);
  };
  let res = 0;
  switch (key) {
    case "popularity":
      res = nullsLast(a.popularity, b.popularity, (x, y) => x - y);
      break;
    case "start":
      res = nullsLast(a.start_date, b.start_date, (x, y) => x.localeCompare(y));
      break;
    case "score":
      res = nullsLast(a.average_score, b.average_score, (x, y) => x - y);
      break;
    case "title":
      res = sign * titleOf(a).localeCompare(titleOf(b));
      break;
  }
  return res !== 0 ? res : (b.popularity ?? 0) - (a.popularity ?? 0);
}

type GridRow =
  | { kind: "header"; key: string; label: string; count: number; dot: string }
  | { kind: "cards"; key: string; items: SeasonalAnime[] };

export const SeasonsView: React.FC<SeasonsViewProps> = ({
  animeList,
  scrollContainerRef,
  keyboardEnabled,
  onGlobalSearch,
  seasonRequest,
  onSeasonRequestHandled,
}) => {
  const showToast = useToast();
  const { openAnime, addAnime } = useAnimeActions();
  const titleOf = useAnimeTitle();
  const nowSeason = useMemo(() => currentSeason(), []);
  const [menu, setMenu] = useState<{ anime: SeasonalAnime; x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  // Start on a requested season so the current one isn't fetched first
  const [selected, setSelected] = useState<SeasonKey>(() =>
    seasonRequest ? { season: seasonRequest.season, year: seasonRequest.year } : nowSeason
  );

  useEffect(() => {
    if (!seasonRequest) return;
    setSelected((prev) =>
      sameSeason(prev, seasonRequest)
        ? prev
        : { season: seasonRequest.season, year: seasonRequest.year }
    );
    onSeasonRequestHandled?.();
  }, [seasonRequest?.nonce]);
  const [result, setResult] = useState<SeasonResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [cachedSeasons, setCachedSeasons] = useState<CachedSeason[]>([]);
  const [filter, setFilter] = useState("");
  const [prefs, updatePrefs] = usePrefs<SeasonPrefs>(PREFS_KEY, DEFAULT_PREFS);
  const [pickerOpen, setPickerOpen] = useState(false);
  const requestIdRef = useRef(0);

  const refreshCachedSeasons = () => {
    toraApi
      .listCachedSeasons()
      .then(setCachedSeasons)
      .catch(() => { });
  };

  const loadSeason = async (key: SeasonKey, force: boolean) => {
    const requestId = ++requestIdRef.current;
    if (force) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await toraApi.getSeason({
        season: key.season,
        year: key.year,
        forceRefresh: force,
      });
      if (requestId !== requestIdRef.current) return;
      setResult(res);
      setLoading(false);
      setRefreshing(false);
      if (!res.from_cache) refreshCachedSeasons();
      // Stale current/upcoming season: keep showing the cached copy and refresh in the background
      if (res.stale) loadSeason(key, true);
    } catch (err: any) {
      if (requestId !== requestIdRef.current) return;
      setLoading(false);
      setRefreshing(false);
      // Don't leave another season's titles under this season's header
      setResult((prev) =>
        prev && prev.season === key.season && prev.year === key.year ? prev : null
      );
      showToast(String(err), "error");
    }
  };

  useEffect(() => {
    refreshCachedSeasons();
  }, []);

  // The previous season stays on screen (dimmed) until the next one arrives, so the page never
  // collapses to the spinner and back (which also toggled the scrollbar and shifted the layout).
  useEffect(() => {
    loadSeason(selected, false);
  }, [selected.season, selected.year]);

  // ←/→ move between seasons when no field is focused
  useEffect(() => {
    if (!keyboardEnabled || pickerOpen || menu) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === "ArrowLeft") setSelected((s) => shiftSeason(s, -1));
      if (e.key === "ArrowRight") setSelected((s) => shiftSeason(s, 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keyboardEnabled, pickerOpen, menu]);

  const listById = useMemo(
    () => new Map(animeList.map((a) => [a.id, a])),
    [animeList]
  );

  const items = result?.items ?? [];
  const knownFormats = useMemo(() => new Set(FORMATS.map((f) => f.id)), []);
  const formatCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of items) counts.set(it.format, (counts.get(it.format) ?? 0) + 1);
    return counts;
  }, [items]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const enabled = new Set(prefs.formats);
    return items
      .filter((it) => !knownFormats.has(it.format) || enabled.has(it.format))
      .filter((it) => matchesFilter(it, needle))
      .sort((a, b) => compareItems(a, b, prefs.sortKey, prefs.sortDir, titleOf));
  }, [items, filter, prefs, knownFormats, titleOf]);

  const groups = useMemo(() => {
    if (prefs.groupBy === "none") {
      return [{ id: "all", label: "", dot: "", items: visible }];
    }
    return STATUS_GROUPS.map((g) => ({
      id: g.id,
      label: g.label,
      dot: g.dot,
      items: visible.filter((it) => {
        const entry = listById.get(it.id);
        return g.statuses.length === 0 ? !entry : !!entry && g.statuses.includes(entry.user_status);
      }),
    })).filter((g) => g.items.length > 0);
  }, [visible, prefs.groupBy, listById]);

  // ---------------------------------------------------------------- virtualized grid

  const gridRef = useRef<HTMLDivElement | null>(null);
  const {
    width: gridWidth,
    top: gridTop,
    scrollTop,
    viewportHeight,
  } = useScrollViewport(gridRef, scrollContainerRef);

  const layout = useMemo(() => {
    const cols = gridWidth >= 960 ? 5 : gridWidth >= 720 ? 4 : gridWidth >= 480 ? 3 : 2;
    const cardWidth = Math.max(120, (gridWidth - (cols - 1) * GRID_GAP) / cols);
    const imageHeight = Math.round(cardWidth * (4 / 3));
    const cardHeight = imageHeight + POSTER_CARD_FOOTER_HEIGHT + 2; // + 1px borders
    return { cols, imageHeight, rowHeight: cardHeight + GRID_GAP };
  }, [gridWidth]);

  const rows = useMemo(() => {
    const out: { row: GridRow; top: number; height: number }[] = [];
    let top = 0;
    for (const g of groups) {
      if (g.label) {
        out.push({
          row: { kind: "header", key: `h-${g.id}`, label: g.label, count: g.items.length, dot: g.dot },
          top,
          height: HEADER_ROW_HEIGHT,
        });
        top += HEADER_ROW_HEIGHT;
      }
      for (let i = 0; i < g.items.length; i += layout.cols) {
        out.push({
          row: { kind: "cards", key: `${g.id}-${i}`, items: g.items.slice(i, i + layout.cols) },
          top,
          height: layout.rowHeight,
        });
        top += layout.rowHeight;
      }
    }
    return { list: out, totalHeight: top };
  }, [groups, layout]);

  const visibleRows = useMemo(() => {
    const overscan = layout.rowHeight * 2;
    const from = scrollTop - gridTop - overscan;
    const [start, end] = visibleRange(rows.list, from, from + viewportHeight + 2 * overscan);
    return rows.list.slice(start, end);
  }, [rows, scrollTop, gridTop, viewportHeight, layout.rowHeight]);

  // ---------------------------------------------------------------- season navigation

  const quickSeasons = useMemo(() => {
    const base = [shiftSeason(nowSeason, -1), nowSeason, shiftSeason(nowSeason, 1)];
    if (!base.some((s) => sameSeason(s, selected))) {
      base.push(selected);
      base.sort(compareSeasons);
    }
    return base;
  }, [nowSeason, selected]);

  const cachedIds = useMemo(
    () => new Set(cachedSeasons.map((c) => `${c.season}-${c.year}`)),
    [cachedSeasons]
  );

  const busy = loading || refreshing;
  const trimmedFilter = filter.trim();
  // Showing the previous season while the selected one loads
  const switching =
    !!result && (result.season !== selected.season || result.year !== selected.year);

  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto">
      <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-4">
        {/* Season header: arrows + picker, quick chips, refresh */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setSelected((s) => shiftSeason(s, -1))}
              title="Previous season (←)"
              className="p-2 rounded-lg hover:bg-bg-tertiary text-text-secondary hover:text-text-primary transition"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="relative">
              <button
                onClick={() => setPickerOpen((o) => !o)}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-bg-tertiary text-lg font-bold text-text-primary transition"
              >
                <CalendarDays className="w-5 h-5 text-accent" />
                {/* Fixed width so the arrows don't shift between "Fall 2026" and "Summer 2026" */}
                <span className="inline-block w-32 text-center tabular-nums">
                  {seasonLabel(selected)}
                </span>
                <ChevronDown className={`w-4 h-4 text-text-muted transition-transform ${pickerOpen ? "rotate-180" : ""}`} />
              </button>
              {pickerOpen && (
                <SeasonPicker
                  selected={selected}
                  nowSeason={nowSeason}
                  cachedIds={cachedIds}
                  onSelect={(key) => {
                    setSelected(key);
                    setPickerOpen(false);
                  }}
                  onClose={() => setPickerOpen(false)}
                />
              )}
            </div>
            <button
              onClick={() => setSelected((s) => shiftSeason(s, 1))}
              title="Next season (→)"
              className="p-2 rounded-lg hover:bg-bg-tertiary text-text-secondary hover:text-text-primary transition"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {quickSeasons.map((s) => {
              const active = sameSeason(s, selected);
              const isNow = sameSeason(s, nowSeason);
              return (
                <button
                  key={seasonId(s)}
                  onClick={() => setSelected(s)}
                  className={`w-28 px-3 py-1.5 rounded-lg text-xs font-semibold border transition flex items-center justify-center gap-1.5 tabular-nums ${active
                    ? "bg-accent text-white border-accent"
                    : "bg-bg-primary text-text-secondary border-border-subtle hover:border-accent/60 hover:text-text-primary"
                    }`}
                >
                  {seasonLabel(s)}
                  {isNow && (
                    <span className={`w-1.5 h-1.5 rounded-full ${active ? "bg-white" : "bg-accent"}`} title="Current season" />
                  )}
                </button>
              );
            })}
          </div>

          <div className="ml-auto flex items-center gap-2">
            {result && (
              <span
                className={`text-[11px] text-text-muted ${switching ? "invisible" : ""}`}
                title={new Date(result.fetched_at * 1000).toLocaleString()}
              >
                Updated {formatUpdated(result.fetched_at)}
              </span>
            )}
            <button
              onClick={() => loadSeason(selected, true)}
              disabled={busy}
              title="Refetch this season from AniList"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-bg-primary border border-border-subtle hover:border-accent/60 text-xs font-medium text-text-primary transition disabled:opacity-60"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
        </div>

        {/* Toolbar: filter, sort, group, formats */}
        <div className="flex flex-wrap items-center gap-2.5">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (trimmedFilter) onGlobalSearch(trimmedFilter);
            }}
            className="relative flex-1 min-w-[220px]"
          >
            <Search className="w-4 h-4 text-text-muted absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setFilter("");
              }}
              placeholder={`Filter ${seasonLabel(selected)}...`}
              className="w-full pl-10 pr-4 py-2 rounded-xl bg-bg-primary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent"
            />
          </form>

          <div className="flex items-center gap-1">
            <select
              value={prefs.sortKey}
              onChange={(e) => {
                const opt = SORT_OPTIONS.find((o) => o.id === e.target.value)!;
                updatePrefs({ sortKey: opt.id, sortDir: opt.defaultDir });
              }}
              className="px-3 py-2 rounded-xl bg-bg-primary border border-border-subtle text-xs text-text-primary"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => updatePrefs({ sortDir: prefs.sortDir === "asc" ? "desc" : "asc" })}
              title={prefs.sortDir === "asc" ? "Ascending" : "Descending"}
              className="p-2 rounded-xl bg-bg-primary border border-border-subtle text-text-secondary hover:text-text-primary transition"
            >
              {prefs.sortDir === "asc" ? (
                <ArrowUpNarrowWide className="w-3.5 h-3.5" />
              ) : (
                <ArrowDownWideNarrow className="w-3.5 h-3.5" />
              )}
            </button>
          </div>

          <select
            value={prefs.groupBy}
            onChange={(e) => updatePrefs({ groupBy: e.target.value as GroupBy })}
            className="px-3 py-2 rounded-xl bg-bg-primary border border-border-subtle text-xs text-text-primary"
          >
            <option value="status">Group: List status</option>
            <option value="none">Group: None</option>
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {FORMATS.filter((f) => formatCounts.has(f.id)).map((f) => {
            const on = prefs.formats.includes(f.id);
            return (
              <button
                key={f.id}
                onClick={() =>
                  updatePrefs({
                    formats: on
                      ? prefs.formats.filter((x) => x !== f.id)
                      : [...prefs.formats, f.id],
                  })
                }
                className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition ${on
                  ? "bg-accent/15 text-accent border-accent/40"
                  : "bg-bg-primary text-text-muted border-border-subtle hover:text-text-secondary"
                  }`}
              >
                {f.label} <span className="opacity-70">{formatCounts.get(f.id)}</span>
              </button>
            );
          })}
          {result && (
            <span className="ml-auto text-[11px] text-text-muted">
              {visible.length} of {items.length} titles
            </span>
          )}
        </div>

        {trimmedFilter && (
          <button
            onClick={() => onGlobalSearch(trimmedFilter)}
            className="w-full text-left px-3 py-2 rounded-lg bg-bg-primary/60 border border-dashed border-border-subtle text-[11px] text-text-muted hover:text-text-primary hover:border-accent/60 transition"
          >
            Press <kbd className="px-1 py-0.5 rounded bg-bg-tertiary font-mono text-[10px]">Enter</kbd> to search all of AniList for "{trimmedFilter}"
          </button>
        )}

        {/* Grid */}
        {loading && !result ? (
          <div className="py-16 text-center text-xs text-text-muted flex flex-col items-center gap-2">
            <RefreshCw className="w-6 h-6 text-accent animate-spin" />
            <span>Loading {seasonLabel(selected)}...</span>
          </div>
        ) : result && visible.length === 0 ? (
          <div className="py-16 text-center text-xs text-text-muted">
            {items.length === 0
              ? `No anime found for ${seasonLabel(selected)}.`
              : "No matches in this season."}
          </div>
        ) : null}

        <div
          ref={gridRef}
          // Dim only if the switch takes a moment (uncached season); cached ones swap instantly
          className={`relative ${switching ? "opacity-50 pointer-events-none transition-opacity delay-200" : ""}`}
          style={{ height: result ? rows.totalHeight : 0 }}
        >
          {result &&
            visibleRows.map(({ row, top, height }) =>
              row.kind === "header" ? (
                <div
                  key={row.key}
                  className="absolute left-0 right-0 flex items-end pb-2"
                  style={{ top, height }}
                >
                  <h2 className="text-xs font-bold uppercase tracking-wider text-text-secondary flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${row.dot}`} />
                    {row.label}
                    <span className="text-text-muted font-medium">{row.count}</span>
                  </h2>
                </div>
              ) : (
                <div
                  key={row.key}
                  className="absolute left-0 right-0 grid"
                  style={{
                    top,
                    height: height - GRID_GAP,
                    gap: GRID_GAP,
                    gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
                  }}
                >
                  {row.items.map((item) => (
                    <AnimePosterCard
                      key={item.id}
                      anime={item}
                      listEntry={listById.get(item.id)}
                      imageHeight={layout.imageHeight}
                      onOpen={openAnime}
                      onAdd={addAnime}
                      onContextMenu={(anime, e) =>
                        setMenu({ anime: anime as SeasonalAnime, x: e.clientX, y: e.clientY })
                      }
                    />
                  ))}
                </div>
              )
            )}
        </div>
      </div>

      {menu && (
        <SeasonAnimeMenu
          key={`${menu.anime.id}-${menu.x}-${menu.y}`}
          anime={menu.anime}
          listEntry={listById.get(menu.anime.id)}
          anchor={{ x: menu.x, y: menu.y }}
          onClose={closeMenu}
          onOpen={openAnime}
          onAdd={addAnime}
        />
      )}
    </div>
  );
};

// ------------------------------------------------------------------ season picker popover

interface SeasonPickerProps {
  selected: SeasonKey;
  nowSeason: SeasonKey;
  cachedIds: Set<string>;
  onSelect: (key: SeasonKey) => void;
  onClose: () => void;
}

const SeasonPicker: React.FC<SeasonPickerProps> = ({
  selected,
  nowSeason,
  cachedIds,
  onSelect,
  onClose,
}) => {
  const maxYear = nowSeason.year + 1;
  const [year, setYear] = useState(selected.year);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const decades = useMemo(() => {
    const out: number[][] = [];
    for (let d = Math.floor(maxYear / 10) * 10; d >= FIRST_SEASON_YEAR; d -= 10) {
      const years: number[] = [];
      for (let y = d; y < d + 10 && y <= maxYear; y++) years.push(y);
      out.push(years);
    }
    return out;
  }, [maxYear]);

  const yearHasCache = (y: number) => SEASONS.some((s) => cachedIds.has(`${s}-${y}`));

  return (
    <div
      ref={ref}
      className="absolute z-40 top-full left-0 mt-2 w-80 p-3 rounded-xl bg-bg-secondary border border-border-subtle shadow-2xl space-y-3"
    >
      <div className="flex items-center justify-between">
        <button
          onClick={() => setYear((y) => Math.max(FIRST_SEASON_YEAR, y - 1))}
          className="p-1.5 rounded-lg hover:bg-bg-tertiary text-text-secondary"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-sm font-bold font-mono text-text-primary">{year}</span>
        <button
          onClick={() => setYear((y) => Math.min(maxYear, y + 1))}
          className="p-1.5 rounded-lg hover:bg-bg-tertiary text-text-secondary"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-4 gap-1.5">
        {SEASONS.map((s) => {
          const key = { season: s, year };
          const active = sameSeason(key, selected);
          const cached = cachedIds.has(seasonId(key));
          const isNow = sameSeason(key, nowSeason);
          return (
            <button
              key={s}
              onClick={() => onSelect(key)}
              className={`relative py-2 rounded-lg text-xs font-semibold border transition ${active
                ? "bg-accent text-white border-accent"
                : isNow
                  ? "bg-bg-primary text-accent border-accent/50"
                  : "bg-bg-primary text-text-secondary border-border-subtle hover:border-accent/60 hover:text-text-primary"
                }`}
            >
              {seasonName(s)}
              {cached && (
                <span
                  className={`absolute top-1 right-1 w-1.5 h-1.5 rounded-full ${active ? "bg-white" : "bg-emerald-400"}`}
                  title="Cached"
                />
              )}
            </button>
          );
        })}
      </div>

      <div className="max-h-52 overflow-y-auto space-y-1.5 pr-1 border-t border-border-subtle pt-2">
        {decades.map((years) => (
          <div key={years[0]} className="flex items-center gap-1">
            <span className="w-10 shrink-0 text-[10px] font-mono text-text-muted">
              {Math.floor(years[0] / 10) * 10}s
            </span>
            <div className="grid grid-cols-10 gap-0.5 flex-1">
              {years.map((y) => (
                <button
                  key={y}
                  onClick={() => setYear(y)}
                  title={String(y)}
                  className={`relative py-1 rounded text-[10px] font-mono transition ${y === year
                    ? "bg-accent text-white"
                    : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                    }`}
                >
                  {String(y).slice(2)}
                  {yearHasCache(y) && y !== year && (
                    <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-emerald-400" />
                  )}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
