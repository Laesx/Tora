import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Columns3,
  Play,
  RefreshCw,
  Rows3,
} from "lucide-react";
import { AiringScheduleItem, AiringScheduleResult, AnimeEntry, BatchAnimeUpdatePatch } from "../types";
import { formatCountdown, getOptimizedCoverUrl, toraApi } from "../api";
import { formatEnum, playLocalEpisode } from "../nowPlaying";
import {
  InferredBreak,
  countryLabel,
  dayKey,
  detectBreaks,
  formatDayHeader,
  formatSlotTime,
  sameDay,
  shiftWeek,
  utcOffsetLabel,
  weekBounds,
  weekDays,
  weekLabel,
  weekStart,
} from "../schedule";
import { AnimeQuickMenu } from "./AnimeQuickMenu";
import { FloatingQuickMenu } from "./FloatingQuickMenu";
import { LIST_STATUS_META } from "./AnimePosterCard";
import { SeasonAnimeMenu } from "./SeasonAnimeMenu";
import { useAnimeTitle } from "../titles";
import type { TorrentSearchRequest } from "../torrents";

interface ScheduleViewProps {
  animeList: AnimeEntry[];
  onOpenAnime: (anime: AnimeEntry) => void;
  onAddAnime: (anime: AnimeEntry, status: "CURRENT" | "PLANNING") => void;
  onChangeStatus: (anime: AnimeEntry, status: string, label: string) => void;
  onRemoveAnime: (anime: AnimeEntry) => void;
  onStepEpisode: (anime: AnimeEntry, delta: number) => void;
  onBatchUpdate: (patch: BatchAnimeUpdatePatch, summaryToast: string) => Promise<void>;
  onBatchDelete: (animeList: AnimeEntry[]) => Promise<void>;
  onSearchTorrents: (req: TorrentSearchRequest) => void;
  onDeleteAnime: (anime: AnimeEntry) => void;
  showToast: (msg: string, type?: "success" | "info" | "error") => void;
}

type Scope = "list" | "all";
type Layout = "columns" | "agenda";
type ListStatusFilter = "all" | "watching";
type Variant = Layout;

interface SchedulePrefs {
  scope: Scope;
  layout: Layout;
  /** Stored as hidden values so formats / countries not seen before stay visible */
  hiddenFormats: string[];
  hiddenCountries: string[];
  listStatus: ListStatusFilter;
}

const PREFS_KEY = "tora.schedule.prefs";
const DEFAULT_PREFS: SchedulePrefs = {
  scope: "list",
  layout: "columns",
  hiddenFormats: [],
  hiddenCountries: [],
  listStatus: "all",
};
const TICK_MS = 30_000;
const WATCHING = ["CURRENT", "REPEATING"];

const LIST_STATUS_OPTIONS: { id: ListStatusFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "watching", label: "Only Watching" },
];

function loadPrefs(): SchedulePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const prefs: SchedulePrefs = { ...DEFAULT_PREFS, ...JSON.parse(raw) };
      // Values from older versions (e.g. the removed "hide_planning") fall back to "all"
      if (prefs.listStatus !== "watching") prefs.listStatus = "all";
      return prefs;
    }
  } catch {
    // storage unavailable or corrupt: defaults
  }
  return DEFAULT_PREFS;
}

function savePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // per-viewer convenience only
  }
}

/** Airings of one day sharing the same time. */
interface Slot {
  airingAt: number;
  items: AiringScheduleItem[];
}

/** One row of a day's timeline: a time slot or an inferred break, ordered by time. */
type DayRow = { kind: "slot"; at: number; slot: Slot } | { kind: "break"; at: number; brk: InferredBreak };

type MenuState =
  | { kind: "list"; anime: AnimeEntry; x: number; y: number }
  | { kind: "remote"; anime: AnimeEntry; x: number; y: number };

/** Weekly airing timetable (Mon–Sun, local time) from AniList's airing schedule. */
export const ScheduleView: React.FC<ScheduleViewProps> = ({
  animeList,
  onOpenAnime,
  onAddAnime,
  onChangeStatus,
  onRemoveAnime,
  onStepEpisode,
  onBatchUpdate,
  onBatchDelete,
  onSearchTorrents,
  onDeleteAnime,
  showToast,
}) => {
  const [start, setStart] = useState(() => weekStart());
  const [prefs, setPrefs] = useState<SchedulePrefs>(loadPrefs);
  const [result, setResult] = useState<AiringScheduleResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const requestIdRef = useRef(0);
  const todayRef = useRef<HTMLElement | null>(null);
  const scrolledForRef = useRef<string | null>(null);

  const updatePrefs = (patch: Partial<SchedulePrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      savePref(PREFS_KEY, JSON.stringify(next));
      return next;
    });
  };

  // Each scope has its own status filter: My list keeps (and persists) `prefs.listStatus`, while
  // All anime starts at "All" every time it's selected, so leaving it restores My list's choice
  const [allScopeStatus, setAllScopeStatus] = useState<ListStatusFilter>("all");
  const statusFilter = prefs.scope === "list" ? prefs.listStatus : allScopeStatus;

  const setScope = (scope: Scope) => {
    if (scope === "all") setAllScopeStatus("all");
    updatePrefs({ scope });
  };

  const setStatusFilter = (status: ListStatusFilter) => {
    if (prefs.scope === "list") updatePrefs({ listStatus: status });
    else setAllScopeStatus(status);
  };

  // Countdowns and the "now" marker
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), TICK_MS);
    return () => clearInterval(t);
  }, []);

  const { from, to } = weekBounds(start);

  const loadWeek = async (weekFrom: number, weekTo: number, force: boolean) => {
    const requestId = ++requestIdRef.current;
    if (force) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await toraApi.getAiringSchedule({ from: weekFrom, to: weekTo, forceRefresh: force });
      if (requestId !== requestIdRef.current) return;
      setResult(res);
      setError(null);
      setLoading(false);
      setRefreshing(false);
      // Stale current/upcoming week: keep showing the cached copy and refresh in the background
      if (res.stale) loadWeek(weekFrom, weekTo, true);
    } catch (err: any) {
      if (requestId !== requestIdRef.current) return;
      setLoading(false);
      setRefreshing(false);
      // Don't leave another week's airings under this week's header
      setResult((prev) => (prev && prev.from === weekFrom ? prev : null));
      setError(String(err));
      // A failed refresh keeps the cached week on screen, so say so
      if (force) showToast(`Airing schedule refresh failed: ${String(err)}`, "error");
    }
  };

  useEffect(() => {
    loadWeek(from, to, false);
  }, [from, to]);

  const listById = useMemo(() => new Map(animeList.map((a) => [a.id, a])), [animeList]);
  const days = useMemo(() => weekDays(start), [start]);

  // The previous week stays on screen (dimmed) until the next one arrives
  const switching = !!result && result.from !== from;
  const weekItems = !result || switching ? [] : result.items;

  // ------------------------------------------------------------------ filters

  const passesStatus = useCallback(
    (entry: AnimeEntry | undefined) => {
      if (prefs.scope === "list" && (!entry || entry.user_status === "DROPPED")) return false;
      if (statusFilter === "watching") return !!entry && WATCHING.includes(entry.user_status);
      return true;
    },
    [prefs.scope, statusFilter]
  );

  // Scope + list status; the base for the format / country chip counts
  const scoped = useMemo(
    () => weekItems.filter((it) => passesStatus(listById.get(it.media.id))),
    [weekItems, listById, passesStatus]
  );

  const { formatCounts, countryCounts } = useMemo(() => {
    const formatCounts = new Map<string, number>();
    const countryCounts = new Map<string, number>();
    for (const it of scoped) {
      if (it.media.format) formatCounts.set(it.media.format, (formatCounts.get(it.media.format) ?? 0) + 1);
      if (it.country) countryCounts.set(it.country, (countryCounts.get(it.country) ?? 0) + 1);
    }
    const byCount = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);
    return { formatCounts: byCount(formatCounts), countryCounts: byCount(countryCounts) };
  }, [scoped]);

  const visible = useMemo(() => {
    const hiddenFormats = new Set(prefs.hiddenFormats);
    const hiddenCountries = new Set(prefs.hiddenCountries);
    return scoped.filter(
      (it) => !hiddenFormats.has(it.media.format) && !(it.country && hiddenCountries.has(it.country))
    );
  }, [scoped, prefs.hiddenFormats, prefs.hiddenCountries]);

  // Breaks: list anime whose weekly slot falls in this week without an airing (any airing, filtered or not)
  const breaks = useMemo(() => {
    if (!result || switching) return [];
    const scheduledIds = new Set(result.items.map((it) => it.media.id));
    const hiddenFormats = new Set(prefs.hiddenFormats);
    const candidates = animeList.filter((a) => passesStatus(a) && !hiddenFormats.has(a.format));
    return detectBreaks(candidates, scheduledIds, from, to, now);
  }, [result, switching, animeList, passesStatus, prefs.hiddenFormats, from, to, now]);

  const rowsByDay = useMemo(() => {
    const out = new Map<string, DayRow[]>();
    const push = (at: number, row: DayRow) => {
      const key = dayKey(new Date(at * 1000));
      const rows = out.get(key) ?? [];
      rows.push(row);
      out.set(key, rows);
    };
    let last: Slot | null = null;
    for (const item of visible) {
      if (last && last.airingAt === item.airing_at) {
        last.items.push(item);
        continue;
      }
      last = { airingAt: item.airing_at, items: [item] };
      push(item.airing_at, { kind: "slot", at: item.airing_at, slot: last });
    }
    for (const brk of breaks) push(brk.expectedAt, { kind: "break", at: brk.expectedAt, brk });
    for (const rows of out.values()) rows.sort((a, b) => a.at - b.at);
    return out;
  }, [visible, breaks]);

  // ------------------------------------------------------------------ actions

  // Schedule media are light; fetch full metadata (stored or once from AniList) before opening / adding
  const fullMedia = async (media: AnimeEntry): Promise<AnimeEntry> => {
    try {
      return (await toraApi.getMediaMetadata(media.id)) ?? media;
    } catch {
      return media;
    }
  };

  const openItem = async (media: AnimeEntry) => {
    const entry = listById.get(media.id);
    onOpenAnime(entry ?? (await fullMedia(media)));
  };

  const openMenu = (media: AnimeEntry, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const entry = listById.get(media.id);
    setMenu(
      entry
        ? { kind: "list", anime: entry, x: e.clientX, y: e.clientY }
        : { kind: "remote", anime: media, x: e.clientX, y: e.clientY }
    );
  };

  const handlers: CardHandlers = {
    onOpen: openItem,
    onContextMenu: openMenu,
    onPlay: (entry, ep) => playLocalEpisode(entry, ep, showToast),
  };

  const today = new Date(now * 1000);
  const isCurrentWeek = sameDay(weekStart(today), start);
  const busy = loading || refreshing;

  // Agenda: bring today into view once per (week, layout) after it renders
  useEffect(() => {
    const key = `${prefs.layout}-${from}`;
    if (prefs.layout !== "agenda" || !isCurrentWeek || !result || switching) return;
    if (scrolledForRef.current === key) return;
    scrolledForRef.current = key;
    todayRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [prefs.layout, from, isCurrentWeek, result, switching]);

  const toggleIn = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const chipClass = (on: boolean) =>
    `px-2.5 py-1 rounded-full text-[11px] font-semibold border transition ${on
      ? "bg-accent/15 text-accent border-accent/40"
      : "bg-bg-primary text-text-muted border-border-subtle hover:text-text-secondary"
    }`;

  const segmentClass = (on: boolean) =>
    `px-3 py-1 rounded-lg text-xs font-semibold transition ${on ? "bg-accent text-white shadow-sm" : "text-text-secondary hover:text-text-primary"
    }`;

  const emptyText = loading && !result ? "Loading…" : switching ? "Loading…" : "Nothing scheduled";

  return (
    <div className="p-6 space-y-4">
      {/* Header: title, week navigation, scope, refresh */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex items-center gap-2 text-lg font-bold text-text-primary">
          <CalendarClock className="w-5 h-5 text-accent" />
          Airing Schedule
        </h1>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setStart((s) => shiftWeek(s, -1))}
            title="Previous week"
            className="p-2 rounded-lg hover:bg-bg-tertiary text-text-secondary hover:text-text-primary transition"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => setStart(weekStart())}
            disabled={isCurrentWeek}
            className="px-3 py-1.5 rounded-lg bg-bg-secondary border border-border-subtle hover:border-accent/60 text-xs font-semibold text-text-primary transition disabled:opacity-50 disabled:hover:border-border-subtle"
          >
            Today
          </button>
          <button
            onClick={() => setStart((s) => shiftWeek(s, 1))}
            title="Next week"
            className="p-2 rounded-lg hover:bg-bg-tertiary text-text-secondary hover:text-text-primary transition"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <span className="ml-1 text-sm font-semibold text-text-secondary tabular-nums">{weekLabel(start)}</span>
          <span className="ml-2 text-[11px] text-text-muted">{utcOffsetLabel(today)}</span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center bg-bg-secondary p-1 rounded-xl border border-border-subtle">
            {(
              [
                { id: "list", label: "My list" },
                { id: "all", label: "All anime" },
              ] as const
            ).map((opt) => (
              <button key={opt.id} onClick={() => setScope(opt.id)} className={segmentClass(prefs.scope === opt.id)}>
                {opt.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => loadWeek(from, to, true)}
            disabled={busy}
            title={
              result
                ? `Refetch this week from AniList • Updated ${new Date(result.fetched_at * 1000).toLocaleString()}`
                : "Refetch this week from AniList"
            }
            className="p-2 rounded-xl bg-bg-secondary hover:bg-bg-tertiary border border-border-subtle text-text-secondary hover:text-text-primary transition disabled:opacity-60"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Toolbar: layout, list status, format & country chips */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center bg-bg-secondary p-1 rounded-xl border border-border-subtle">
          <button
            onClick={() => updatePrefs({ layout: "columns" })}
            title="Week columns"
            className={`p-1.5 rounded-lg transition ${prefs.layout === "columns" ? "bg-accent text-white" : "text-text-muted hover:text-text-primary"}`}
          >
            <Columns3 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => updatePrefs({ layout: "agenda" })}
            title="Days stacked vertically"
            className={`p-1.5 rounded-lg transition ${prefs.layout === "agenda" ? "bg-accent text-white" : "text-text-muted hover:text-text-primary"}`}
          >
            <Rows3 className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex items-center bg-bg-secondary p-1 rounded-xl border border-border-subtle">
          {LIST_STATUS_OPTIONS.map((opt) => (
            <button key={opt.id} onClick={() => setStatusFilter(opt.id)} className={segmentClass(statusFilter === opt.id)}>
              {opt.label}
            </button>
          ))}
        </div>

        {formatCounts.length > 0 && <span className="w-px h-5 bg-border-subtle mx-1" />}
        {formatCounts.map(([format, count]) => (
          <button
            key={format}
            onClick={() => updatePrefs({ hiddenFormats: toggleIn(prefs.hiddenFormats, format) })}
            className={chipClass(!prefs.hiddenFormats.includes(format))}
          >
            {formatEnum(format)} <span className="opacity-70">{count}</span>
          </button>
        ))}

        {countryCounts.length > 0 && <span className="w-px h-5 bg-border-subtle mx-1" />}
        {countryCounts.map(([country, count]) => (
          <button
            key={country}
            onClick={() => updatePrefs({ hiddenCountries: toggleIn(prefs.hiddenCountries, country) })}
            className={chipClass(!prefs.hiddenCountries.includes(country))}
            title={country}
          >
            {countryLabel(country)} <span className="opacity-70">{count}</span>
          </button>
        ))}

        {result && !switching && (
          <span className="ml-auto text-[11px] text-text-muted">
            {visible.length} of {scoped.length} episodes
            {breaks.length > 0 && ` · ${breaks.length} on break`}
          </span>
        )}
      </div>

      {error && !result && (
        <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-6 text-center space-y-3">
          <div className="text-xs text-rose-300">Couldn't load the airing schedule: {error}</div>
          <button
            onClick={() => loadWeek(from, to, false)}
            className="px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-semibold"
          >
            Retry
          </button>
        </div>
      )}

      {(!error || result) && (
        <div className={`transition-opacity ${switching || (loading && !result) ? "opacity-50" : ""}`}>
          {prefs.layout === "columns" ? (
            <div className="overflow-x-auto pb-2">
              <div className="grid grid-cols-7 gap-4 min-w-[1120px]">
                {days.map((day) => (
                  <DaySection
                    key={dayKey(day)}
                    day={day}
                    variant="columns"
                    isToday={sameDay(day, today)}
                    rows={rowsByDay.get(dayKey(day)) ?? []}
                    now={now}
                    emptyText={emptyText}
                    listById={listById}
                    handlers={handlers}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-6 max-w-7xl">
              {days.map((day) => {
                const isToday = sameDay(day, today);
                return (
                  <DaySection
                    key={dayKey(day)}
                    sectionRef={isToday ? todayRef : undefined}
                    day={day}
                    variant="agenda"
                    isToday={isToday}
                    rows={rowsByDay.get(dayKey(day)) ?? []}
                    now={now}
                    emptyText={emptyText}
                    listById={listById}
                    handlers={handlers}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {!loading && !switching && result && visible.length === 0 && breaks.length === 0 && (
        <div className="text-center text-xs text-text-muted">
          {scoped.length > 0
            ? "Every airing this week is hidden by the format / country filters."
            : prefs.scope === "list"
              ? "Nothing on your list airs this week."
              : "AniList has no airings for this week."}
          {prefs.scope === "list" && scoped.length === 0 && (
            <button onClick={() => setScope("all")} className="ml-1.5 font-semibold text-accent hover:underline">
              Show all anime
            </button>
          )}
        </div>
      )}

      {menu?.kind === "list" && (
        <FloatingQuickMenu anchor={menu} onClose={closeMenu}>
          <AnimeQuickMenu
            anime={listById.get(menu.anime.id) ?? menu.anime}
            onClose={closeMenu}
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
      {menu?.kind === "remote" && (
        <SeasonAnimeMenu
          key={`${menu.anime.id}-${menu.x}-${menu.y}`}
          anime={menu.anime}
          listEntry={listById.get(menu.anime.id)}
          anchor={{ x: menu.x, y: menu.y }}
          onClose={closeMenu}
          onOpen={openItem}
          onAdd={async (anime, status) => onAddAnime(await fullMedia(anime), status)}
          onChangeStatus={onChangeStatus}
          onRemove={onRemoveAnime}
          showToast={showToast}
        />
      )}
    </div>
  );
};

// ------------------------------------------------------------------ day / rows

interface CardHandlers {
  onOpen: (media: AnimeEntry) => void;
  onContextMenu: (media: AnimeEntry, e: React.MouseEvent) => void;
  onPlay: (entry: AnimeEntry, episode: number) => void;
}

const DaySection: React.FC<{
  day: Date;
  variant: Variant;
  isToday: boolean;
  rows: DayRow[];
  now: number;
  emptyText: string;
  listById: Map<number, AnimeEntry>;
  handlers: CardHandlers;
  sectionRef?: React.Ref<HTMLElement>;
}> = ({ day, variant, isToday, rows, now, emptyText, listById, handlers, sectionRef }) => {
  const header = formatDayHeader(day);
  // The "now" marker goes before the first upcoming row of today
  const upcoming = isToday ? rows.findIndex((r) => r.at > now) : -1;
  const markerAt = isToday ? (upcoming === -1 ? rows.length : upcoming) : -1;
  const episodes = rows.reduce((n, r) => n + (r.kind === "slot" ? r.slot.items.length : 0), 0);
  return (
    <section ref={sectionRef} className="min-w-0 scroll-mt-4">
      <h2 className="mb-3 flex items-baseline gap-1.5">
        <span className={`text-lg font-extrabold ${isToday ? "text-accent" : "text-text-primary"}`}>{header.weekday}</span>
        <span className={`text-sm ${isToday ? "text-accent/80" : "text-text-muted"}`}>{header.date}</span>
        {variant === "agenda" && episodes > 0 && (
          <span className="ml-1 text-[11px] text-text-muted">
            {episodes} episode{episodes === 1 ? "" : "s"}
          </span>
        )}
      </h2>

      <div className="relative ml-1 pl-4 border-l border-border-subtle space-y-4 min-h-12">
        {rows.length === 0 && <div className="text-xs text-text-muted pt-0.5">{emptyText}</div>}
        {rows.map((row, i) => (
          <React.Fragment key={row.kind === "slot" ? `s-${row.at}` : `b-${row.brk.entry.id}`}>
            {i === markerAt && <NowMarker now={now} />}
            {row.kind === "slot" ? (
              <TimeRow at={row.at} now={now} variant={variant}>
                {row.slot.items.map((item) => (
                  <ScheduleCard
                    key={`${item.media.id}-${item.episode}`}
                    item={item}
                    entry={listById.get(item.media.id)}
                    aired={row.at <= now}
                    handlers={handlers}
                  />
                ))}
              </TimeRow>
            ) : (
              <TimeRow at={row.at} now={now} variant={variant} isBreak>
                <BreakCard brk={row.brk} handlers={handlers} />
              </TimeRow>
            )}
          </React.Fragment>
        ))}
        {markerAt === rows.length && <NowMarker now={now} />}
      </div>
    </section>
  );
};

const NowMarker: React.FC<{ now: number }> = ({ now }) => (
  <div className="relative -ml-4 flex items-center">
    <span className="absolute -left-[3px] w-1.5 h-1.5 rounded-full bg-accent" />
    <span className="ml-2 px-3 py-1 rounded-full bg-accent text-white text-[11px] font-semibold shadow-sm tabular-nums">
      {formatSlotTime(now)} {utcOffsetLabel(new Date(now * 1000))}
    </span>
  </div>
);

/** Timeline row: time label (above the cards in columns, beside them in agenda) and its cards. */
const TimeRow: React.FC<{
  at: number;
  now: number;
  variant: Variant;
  isBreak?: boolean;
  children: React.ReactNode;
}> = ({ at, now, variant, isBreak, children }) => {
  const aired = at <= now;
  const label = (
    <div
      className={`relative flex ${variant === "agenda" ? "flex-col w-24 shrink-0 pt-1.5" : "items-baseline gap-1.5 mb-1.5"}`}
    >
      <span
        className={`absolute -left-[21px] ${variant === "agenda" ? "top-[11px]" : "top-1.5"} w-2 h-2 rounded-full border-2 ${isBreak
          ? "bg-amber-500/40 border-amber-500/70"
          : aired
            ? "bg-bg-tertiary border-border-subtle"
            : "bg-accent border-accent"
          }`}
      />
      <span className="text-xs font-bold text-text-primary tabular-nums">{formatSlotTime(at)}</span>
      <span className={`text-[10px] font-mono ${isBreak ? "text-amber-300" : aired ? "text-text-muted" : "text-emerald-400"}`}>
        {isBreak ? "break" : aired ? "aired" : formatCountdown(at)}
      </span>
    </div>
  );
  if (variant === "agenda") {
    return (
      <div className={`flex gap-4 ${aired && !isBreak ? "opacity-70" : ""}`}>
        {label}
        <div className="flex-1 min-w-0 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-4 gap-y-1.5">{children}</div>
      </div>
    );
  }
  return (
    <div className={aired && !isBreak ? "opacity-70" : ""}>
      {label}
      <div className="space-y-1.5">{children}</div>
    </div>
  );
};

// ------------------------------------------------------------------ cards

const ScheduleCard: React.FC<{
  item: AiringScheduleItem;
  entry: AnimeEntry | undefined;
  aired: boolean;
  handlers: CardHandlers;
}> = ({ item, entry, aired, handlers }) => {
  const titleOf = useAnimeTitle();
  const anime = entry ?? item.media;
  const status = entry ? LIST_STATUS_META[entry.user_status] : undefined;
  const watched = !!entry && entry.user_progress >= item.episode;
  // The user's next episode (up to this airing) is downloaded and ready to play
  const nextEp = entry ? entry.user_progress + 1 : 0;
  const nextReady = !!entry && nextEp <= item.episode && entry.available_episodes.includes(nextEp);
  const behind =
    entry && aired && WATCHING.includes(entry.user_status) ? Math.max(0, item.episode - entry.user_progress) : 0;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => handlers.onOpen(item.media)}
      onKeyDown={(e) => {
        if (e.key === "Enter") handlers.onOpen(item.media);
      }}
      onContextMenu={(e) => handlers.onContextMenu(item.media, e)}
      title={titleOf(anime)}
      className="group w-full flex gap-2.5 p-1.5 -ml-1.5 rounded-xl hover:bg-bg-tertiary text-left transition cursor-pointer focus:outline-none"
    >
      <div className="relative w-12 h-[68px] shrink-0 rounded-lg overflow-hidden bg-bg-tertiary">
        <img
          src={getOptimizedCoverUrl(anime.cover_image, "medium")}
          alt={titleOf(anime)}
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover"
        />
        {nextReady && entry && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              handlers.onPlay(entry, nextEp);
            }}
            title={`Play episode ${nextEp}`}
            className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition flex items-center justify-center"
          >
            <Play className="w-5 h-5 text-white fill-current" />
          </button>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-bold text-text-primary leading-snug line-clamp-2 group-hover:text-accent transition">
          {titleOf(anime)}
        </div>
        <div className="text-[10px] text-text-muted mt-0.5">
          EP {item.episode}
          {anime.episodes ? `/${anime.episodes}` : ""}
          {anime.format ? ` · ${formatEnum(anime.format)}` : ""}
          {item.country && item.country !== "JP" ? ` · ${item.country}` : ""}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 mt-1">
          {status && <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold ${status.badge}`}>{status.label}</span>}
          {watched && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" aria-label="Watched" />}
          {behind > 0 && <span className="text-[10px] font-semibold text-amber-300">{behind} behind</span>}
          {nextReady && entry && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handlers.onPlay(entry, nextEp);
              }}
              title={`Episode ${nextEp} is in your library — click to play`}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 text-[10px] font-semibold transition"
            >
              <Play className="w-2.5 h-2.5 fill-current" />
              Ep {nextEp}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

const BreakCard: React.FC<{ brk: InferredBreak; handlers: CardHandlers }> = ({ brk, handlers }) => {
  const titleOf = useAnimeTitle();
  const next = new Date(brk.nextAt * 1000);
  const nextLabel = next.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => handlers.onOpen(brk.entry)}
      onKeyDown={(e) => {
        if (e.key === "Enter") handlers.onOpen(brk.entry);
      }}
      onContextMenu={(e) => handlers.onContextMenu(brk.entry, e)}
      title={titleOf(brk.entry)}
      className="w-full flex gap-2.5 p-2.5 rounded-xl bg-amber-500/5 border border-amber-500/25 hover:border-amber-500/50 text-left transition cursor-pointer focus:outline-none"
    >
      <CircleAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-bold text-text-primary leading-snug line-clamp-2">{titleOf(brk.entry)}</div>
        <div className="text-[10px] text-text-secondary mt-0.5">No episode this week</div>
        <div className="text-[10px] text-text-muted">
          Next: Ep {brk.nextEpisode}, {nextLabel} {formatSlotTime(brk.nextAt)}
        </div>
      </div>
    </div>
  );
};
