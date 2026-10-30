import React, { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  CalendarDays,
  Clock,
  Flame,
  HardDrive,
  ListTodo,
  Play,
  Star,
  Trophy,
  Tv,
} from "lucide-react";
import {
  AnimeEntry,
  DriveStorageSummary,
  ListStats,
  MANUAL_HISTORY_PLAYER,
  WatchEvent,
} from "@/lib/types";
import { formatBytes } from "@/lib/format";
import { getOptimizedCoverUrl } from "@/lib/covers";
import { STATUS_INFO } from "@/lib/status";
import { toraApi } from "@/lib/api";
import { useAnimeTitle } from "@/contexts/titles";
import { AiringDot } from "@/components/AiringDot";
import { useAnimeActions } from "@/contexts/animeActions";
import { useScoreFormat } from "@/contexts/scoreFormat";
import { formatMeanScore } from "@/lib/scores";
import { useAniListHistory } from "@/contexts/anilistHistory";
import { usePrefs } from "@/hooks/usePrefs";

interface StatsViewProps {
  animeList: AnimeEntry[];
  /** Changes whenever the numbers may have changed (list edits, scrobbles) */
  refreshKey: unknown;
  /** Open the watchlist on one status */
  onOpenStatus: (status: string) => void;
}

// Segment order of the status bar = the order its colors were validated in (adjacent pairs)
const STATUS_SEGMENTS = ["CURRENT", "REPEATING", "COMPLETED", "PAUSED", "DROPPED", "PLANNING"].map((id) => ({
  id,
  label: STATUS_INFO[id].shortLabel,
  color: STATUS_INFO[id].chart,
}));

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const HEATMAP_WEEKS = 53;
const CELL = 11;
const GAP = 2;

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

const startOfDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

function formatHours(minutes: number): string {
  const h = minutes / 60;
  if (h < 1) return `${Math.round(minutes)} min`;
  return `${h < 10 ? h.toFixed(1) : Math.round(h).toLocaleString()} h`;
}

/** Activity numbers from watched-episode events, bucketed by local day. */
function computeActivity(events: WatchEvent[]) {
  const perDay = new Map<string, number>();
  const weekday = new Array(7).fill(0);
  const hour = new Array(24).fill(0);
  const players = new Map<string, number>();
  for (const e of events) {
    const d = new Date(e.t * 1000);
    const k = dayKey(d);
    perDay.set(k, (perDay.get(k) ?? 0) + 1);
    weekday[d.getDay()]++;
    hour[d.getHours()]++;
    const p = e.player === MANUAL_HISTORY_PLAYER ? "Manual updates" : e.player;
    players.set(p, (players.get(p) ?? 0) + 1);
  }

  // Streaks: consecutive days with at least one episode; the current one may end yesterday
  const today = startOfDay(new Date());
  const cursor = new Date(today);
  if (!perDay.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let current = 0;
  while (perDay.has(dayKey(cursor))) {
    current++;
    cursor.setDate(cursor.getDate() - 1);
  }
  let longest = 0;
  let run = 0;
  const walk = new Date(today);
  walk.setDate(walk.getDate() - 366);
  while (walk <= today) {
    run = perDay.has(dayKey(walk)) ? run + 1 : 0;
    longest = Math.max(longest, run);
    walk.setDate(walk.getDate() + 1);
  }

  // Last 12 calendar months, oldest first
  const months: { label: string; title: string; count: number; minutes: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    const m = new Date(today.getFullYear(), today.getMonth() - i, 1);
    months.push({
      label: m.toLocaleDateString(undefined, { month: "short" }),
      title: m.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
      count: 0,
      minutes: 0,
    });
  }
  const firstMonth = new Date(today.getFullYear(), today.getMonth() - 11, 1);
  for (const e of events) {
    const d = new Date(e.t * 1000);
    if (d < firstMonth) continue;
    const idx = (d.getFullYear() - firstMonth.getFullYear()) * 12 + d.getMonth() - firstMonth.getMonth();
    if (idx >= 0 && idx < 12) {
      months[idx].count++;
      months[idx].minutes += e.minutes;
    }
  }

  const argmax = (xs: number[]) => xs.reduce((best, v, i) => (v > xs[best] ? i : best), 0);
  const busiestDay = events.length ? WEEKDAYS[argmax(weekday)] : null;
  const h = argmax(hour);
  const busiestHour = events.length
    ? `${new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" })}–${new Date(2000, 0, 1, (h + 1) % 24).toLocaleTimeString([], { hour: "numeric" })}`
    : null;

  return {
    perDay,
    current,
    longest,
    months,
    busiestDay,
    busiestHour,
    players: Array.from(players.entries()).sort((a, b) => b[1] - a[1]),
  };
}

/** Local-time 53-week grid ending this week; columns are weeks (Sun..Sat). */
function heatmapCells(perDay: Map<string, number>) {
  const today = startOfDay(new Date());
  const start = new Date(today);
  start.setDate(start.getDate() - today.getDay() - (HEATMAP_WEEKS - 1) * 7);
  const cells: { x: number; y: number; date: Date; count: number }[] = [];
  const monthLabels: { x: number; label: string }[] = [];
  const d = new Date(start);
  for (let w = 0; w < HEATMAP_WEEKS; w++) {
    for (let day = 0; day < 7; day++) {
      if (d > today) break;
      if (day === 0 && d.getDate() <= 7) {
        monthLabels.push({ x: w, label: d.toLocaleDateString(undefined, { month: "short" }) });
      }
      cells.push({ x: w, y: day, date: new Date(d), count: perDay.get(dayKey(d)) ?? 0 });
      d.setDate(d.getDate() + 1);
    }
  }
  return { cells, monthLabels };
}

/** Accent opacity step for a day (sequential: one hue, light → dark). 0 = empty cell. */
function heatLevel(count: number, max: number): number {
  if (count === 0) return 0;
  if (max <= 1) return 4;
  return Math.min(4, Math.ceil((count / max) * 4));
}
const HEAT_OPACITY = [0, 0.3, 0.5, 0.75, 1];

/**
 * Your list, watch activity and backlog. Everything is local: list + history + library, no AniList calls.
 * With "Include AniList history" (per device, off by default) the activity also counts imported AniList
 * episodes Tora didn't log itself.
 */
export const StatsView: React.FC<StatsViewProps> = ({
  animeList,
  refreshKey,
  onOpenStatus,
}) => {
  const { openAnime } = useAnimeActions();
  const titleOf = useAnimeTitle();
  const scoreFormat = useScoreFormat();
  const [stats, setStats] = useState<ListStats | null>(null);
  const [drives, setDrives] = useState<DriveStorageSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const anilist = useAniListHistory();
  const [prefs, updatePrefs] = usePrefs("tora.stats.prefs", { includeAnilist: false });
  const includeAnilist = prefs.includeAnilist && anilist.hasData;
  // Imported activity only matters while it is included
  const anilistVersion = includeAnilist ? anilist.version : 0;

  useEffect(() => {
    let cancelled = false;
    Promise.all([toraApi.getStats(includeAnilist), toraApi.getDriveSummaries()])
      .then(([s, d]) => {
        if (cancelled) return;
        setStats(s);
        setDrives(d);
        setError(null);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [refreshKey, includeAnilist, anilistVersion]);

  const byId = useMemo(() => new Map(animeList.map((a) => [a.id, a])), [animeList]);
  const activity = useMemo(() => computeActivity(stats?.watch_events ?? []), [stats]);

  if (error) {
    return (
      <div className="p-6 max-w-6xl mx-auto text-xs text-rose-400">Couldn't load stats: {error}</div>
    );
  }
  if (!stats) {
    return <div className="p-6 max-w-6xl mx-auto text-xs text-text-muted">Loading stats...</div>;
  }

  const completed = stats.status_counts.COMPLETED ?? 0;
  const dropped = stats.status_counts.DROPPED ?? 0;
  const completionRate = completed + dropped > 0 ? Math.round((completed / (completed + dropped)) * 100) : null;
  const ready = stats.ready_to_watch
    .map((r) => ({ ...r, anime: byId.get(r.anime_id) }))
    .filter((r): r is typeof r & { anime: AnimeEntry } => Boolean(r.anime));
  const readyEpisodes = ready.reduce((n, r) => n + r.unwatched_on_disk, 0);

  return (
    <div className="p-6 space-y-5 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-bold text-text-primary flex items-center gap-2.5">
          <BarChart3 className="w-6 h-6 text-accent" />
          Stats
        </h1>
        {anilist.hasData && (
          <label
            className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer"
            title="Count imported AniList episodes that Tora didn't log itself in the activity charts"
          >
            <input
              type="checkbox"
              checked={prefs.includeAnilist}
              onChange={(e) => updatePrefs({ includeAnilist: e.target.checked })}
              className="rounded accent-accent w-4 h-4 cursor-pointer"
            />
            Include AniList history
          </label>
        )}
      </div>

      {/* ---- Overview */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatTile icon={<Tv className="w-4 h-4" />} value={stats.total_entries.toLocaleString()} label="Anime in list" />
        <StatTile
          icon={<Play className="w-4 h-4" />}
          value={stats.episodes_watched.toLocaleString()}
          label="Episodes watched"
          note="Rewatches included"
        />
        <StatTile
          icon={<Clock className="w-4 h-4" />}
          value={(stats.minutes_watched / 1440).toFixed(1)}
          label="Days watched"
          note={`${formatHours(stats.minutes_watched)} in total`}
        />
        <StatTile
          icon={<Star className="w-4 h-4" />}
          value={stats.mean_score !== null ? formatMeanScore(stats.mean_score, scoreFormat) : "—"}
          label="Mean score"
          note={`${stats.scored_count} scored`}
        />
        <StatTile
          icon={<Trophy className="w-4 h-4" />}
          value={completionRate !== null ? `${completionRate}%` : "—"}
          label="Completion rate"
          note={`${completed} completed · ${dropped} dropped`}
        />
      </div>

      <Section title="Status breakdown">
        <StatusBar counts={stats.status_counts} total={stats.total_entries} onOpenStatus={onOpenStatus} />
      </Section>

      {/* ---- Activity */}
      <Section
        title="Activity"
        aside={
          stats.first_logged_at
            ? `${stats.logged_episodes.toLocaleString()} episodes logged since ${new Date(
                stats.first_logged_at * 1000
              ).toLocaleDateString()}`
            : undefined
        }
      >
        {stats.logged_episodes === 0 ? (
          <div className="py-8 text-center text-xs text-text-muted">
            No watch history yet. Play an episode or update your progress to start tracking.
          </div>
        ) : (
          <div className="space-y-5">
            <Heatmap perDay={activity.perDay} />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MiniStat icon={<Flame className="w-4 h-4" />} value={`${activity.current} d`} label="Current streak" />
              <MiniStat icon={<Trophy className="w-4 h-4" />} value={`${activity.longest} d`} label="Longest streak (1 year)" />
              <MiniStat icon={<CalendarDays className="w-4 h-4" />} value={activity.busiestDay ?? "—"} label="Busiest weekday" />
              <MiniStat icon={<Clock className="w-4 h-4" />} value={activity.busiestHour ?? "—"} label="Busiest hour" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              <div className="md:col-span-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-2">
                  Episodes per month
                </h3>
                <MonthBars months={activity.months} />
              </div>
              <div>
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-2">
                  Logged by (last year)
                </h3>
                <PlayerList players={activity.players} />
              </div>
            </div>
          </div>
        )}
      </Section>

      {/* ---- Library & backlog */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatTile
          icon={<Play className="w-4 h-4" />}
          value={readyEpisodes.toLocaleString()}
          label="Downloaded, not watched"
          note={`${ready.length} anime`}
        />
        <StatTile
          icon={<ListTodo className="w-4 h-4" />}
          value={formatHours(stats.watching_remaining_minutes)}
          label="Left on Watching"
          note={`${stats.watching_remaining_episodes.toLocaleString()} episodes`}
        />
        <StatTile
          icon={<CalendarDays className="w-4 h-4" />}
          value={formatHours(stats.planning_minutes)}
          label="Planning backlog"
          note={`${(stats.status_counts.PLANNING ?? 0).toLocaleString()} anime · ${stats.planning_episodes.toLocaleString()} episodes`}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <Section title="Ready to watch" className="md:col-span-2" aside={ready.length ? `${ready.length}` : undefined}>
          {ready.length === 0 ? (
            <div className="py-6 text-center text-xs text-text-muted">
              Nothing downloaded past your progress.
            </div>
          ) : (
            <div className="space-y-1 max-h-96 overflow-y-auto pr-1">
              {ready.map(({ anime, unwatched_on_disk, next_episode_on_disk }) => (
                <button
                  key={anime.id}
                  onClick={() => openAnime(anime)}
                  className="w-full flex items-center gap-3 p-2 rounded-xl hover:bg-bg-tertiary text-left transition focus:outline-none"
                >
                  <span className="relative shrink-0">
                    <img
                      src={getOptimizedCoverUrl(anime.cover_image, "medium")}
                      alt={titleOf(anime)}
                      loading="lazy"
                      decoding="async"
                      className="w-8 h-11 object-cover rounded-md"
                    />
                    <AiringDot anime={anime} size="sm" onCover className="absolute -top-0.5 -left-0.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold text-text-primary truncate">{titleOf(anime)}</div>
                    <div className="text-[11px] text-text-muted">
                      {next_episode_on_disk ? `Ep ${anime.user_progress + 1} ready` : "Next episode missing"}
                      {" · "}
                      {anime.user_progress}/{anime.episodes ?? "?"}
                    </div>
                  </div>
                  <span className="text-[11px] font-mono text-text-secondary shrink-0">
                    {unwatched_on_disk} on disk
                  </span>
                </button>
              ))}
            </div>
          )}
        </Section>

        <Section title="Library drives">
          {drives.length === 0 ? (
            <div className="py-6 text-center text-xs text-text-muted">
              No library folders. Add one in Settings → Library.
            </div>
          ) : (
            <div className="space-y-3">
              {drives.map((d) => {
                const used = d.drive_total_bytes - d.drive_free_bytes;
                const animePct = d.drive_total_bytes ? (d.anime_bytes / d.drive_total_bytes) * 100 : 0;
                const otherPct = d.drive_total_bytes
                  ? (Math.max(0, used - d.anime_bytes) / d.drive_total_bytes) * 100
                  : 0;
                return (
                  <div key={d.drive_root} className="space-y-1.5">
                    <div className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="font-semibold text-text-primary flex items-center gap-1.5">
                        <HardDrive className="w-3.5 h-3.5 text-text-muted" />
                        {d.drive_root}
                      </span>
                      <span className="text-[11px] text-text-muted">
                        {d.anime_file_count.toLocaleString()} files · {formatBytes(d.anime_bytes)}
                      </span>
                    </div>
                    <div
                      className="flex h-2 rounded-full overflow-hidden bg-bg-tertiary gap-[2px]"
                      title={`Anime ${formatBytes(d.anime_bytes)} · other ${formatBytes(Math.max(0, used - d.anime_bytes))} · free ${formatBytes(d.drive_free_bytes)}`}
                    >
                      <div className="bg-accent rounded-l-full" style={{ width: `${animePct}%` }} />
                      <div className="bg-text-muted/40" style={{ width: `${otherPct}%` }} />
                    </div>
                    <div className="text-[10px] text-text-muted">{formatBytes(d.drive_free_bytes)} free</div>
                  </div>
                );
              })}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
};

const Section: React.FC<{
  title: string;
  aside?: string;
  className?: string;
  children: React.ReactNode;
}> = ({ title, aside, className = "", children }) => (
  <section className={`bg-bg-secondary border border-border-subtle rounded-2xl p-4 space-y-3 ${className}`}>
    <h2 className="text-sm font-bold text-text-primary flex items-baseline justify-between gap-2">
      {title}
      {aside && <span className="text-[11px] font-medium text-text-muted">{aside}</span>}
    </h2>
    {children}
  </section>
);

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

const MiniStat: React.FC<{ icon: React.ReactNode; value: string; label: string }> = ({ icon, value, label }) => (
  <div className="bg-bg-primary border border-border-subtle rounded-xl p-3">
    <div className="flex items-center gap-2 text-accent">
      {icon}
      <span className="text-sm font-bold text-text-primary">{value}</span>
    </div>
    <div className="text-[11px] text-text-muted mt-0.5">{label}</div>
  </div>
);

/** Stacked bar of entries per status (2px gaps between segments) + a legend with counts that opens each list. */
const StatusBar: React.FC<{
  counts: Record<string, number>;
  total: number;
  onOpenStatus: (status: string) => void;
}> = ({ counts, total, onOpenStatus }) => {
  const [hover, setHover] = useState<string | null>(null);
  const segments = STATUS_SEGMENTS.filter((s) => (counts[s.id] ?? 0) > 0);
  if (total === 0) {
    return <div className="py-4 text-center text-xs text-text-muted">Your list is empty.</div>;
  }
  return (
    <div className="space-y-3">
      <div className="flex h-4 gap-[2px]" onMouseLeave={() => setHover(null)}>
        {segments.map((s, i) => {
          const n = counts[s.id] ?? 0;
          return (
            <button
              key={s.id}
              onClick={() => onOpenStatus(s.id)}
              onMouseEnter={() => setHover(s.id)}
              aria-label={`${s.label}: ${n}`}
              className={`h-full transition-opacity focus:outline-none ${i === 0 ? "rounded-l" : ""} ${
                i === segments.length - 1 ? "rounded-r" : ""
              } ${hover && hover !== s.id ? "opacity-40" : ""}`}
              style={{ flexGrow: n, flexBasis: 0, minWidth: 4, backgroundColor: s.color }}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {segments.map((s) => {
          const n = counts[s.id] ?? 0;
          return (
            <button
              key={s.id}
              onClick={() => onOpenStatus(s.id)}
              onMouseEnter={() => setHover(s.id)}
              onMouseLeave={() => setHover(null)}
              className={`flex items-center gap-1.5 text-xs rounded px-1 -mx-1 hover:bg-bg-tertiary transition ${
                hover === s.id ? "bg-bg-tertiary" : ""
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: s.color }} />
              <span className="text-text-secondary">{s.label}</span>
              <span className="font-semibold text-text-primary">{n}</span>
              <span className="text-text-muted">{Math.round((n / total) * 100)}%</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

/** 53-week day heatmap (accent opacity = episodes that day). */
const Heatmap: React.FC<{ perDay: Map<string, number> }> = ({ perDay }) => {
  const [hover, setHover] = useState<{ date: Date; count: number; x: number; y: number } | null>(null);
  const { cells, monthLabels } = useMemo(() => heatmapCells(perDay), [perDay]);
  const max = useMemo(() => Math.max(0, ...cells.map((c) => c.count)), [cells]);
  const left = 28;
  const top = 14;
  const width = left + HEATMAP_WEEKS * (CELL + GAP);
  const height = top + 7 * (CELL + GAP);
  return (
    <div className="relative">
      <div className="overflow-x-auto">
        <svg
          width={width}
          height={height}
          className="block"
          role="img"
          aria-label="Episodes watched per day over the last year"
          onMouseLeave={() => setHover(null)}
        >
          {monthLabels.map((m) => (
            <text
              key={`${m.x}-${m.label}`}
              x={left + m.x * (CELL + GAP)}
              y={9}
              className="fill-text-muted"
              fontSize={9}
            >
              {m.label}
            </text>
          ))}
          {[1, 3, 5].map((d) => (
            <text key={d} x={0} y={top + d * (CELL + GAP) + CELL - 2} className="fill-text-muted" fontSize={9}>
              {WEEKDAYS[d].slice(0, 3)}
            </text>
          ))}
          {cells.map((c) => {
            const level = heatLevel(c.count, max);
            const x = left + c.x * (CELL + GAP);
            const y = top + c.y * (CELL + GAP);
            return (
              <rect
                key={`${c.x}-${c.y}`}
                x={x}
                y={y}
                width={CELL}
                height={CELL}
                rx={2}
                className={level === 0 ? "fill-bg-tertiary" : "fill-accent"}
                fillOpacity={level === 0 ? 1 : HEAT_OPACITY[level]}
                onMouseEnter={() => setHover({ date: c.date, count: c.count, x: x + CELL / 2, y })}
              />
            );
          })}
        </svg>
      </div>
      {hover && (
        <div
          className="absolute pointer-events-none -translate-x-1/2 -translate-y-full px-2 py-1 rounded-lg bg-bg-elevated border border-border-subtle text-[11px] text-text-primary whitespace-nowrap shadow-lg"
          style={{ left: hover.x, top: hover.y - 4 }}
        >
          <span className="font-semibold">
            {hover.count} episode{hover.count === 1 ? "" : "s"}
          </span>{" "}
          <span className="text-text-muted">
            {hover.date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
          </span>
        </div>
      )}
      <div className="flex items-center justify-end gap-1 mt-2 text-[10px] text-text-muted">
        Less
        {HEAT_OPACITY.map((o, i) => (
          <span
            key={i}
            className={`w-2.5 h-2.5 rounded-sm ${i === 0 ? "bg-bg-tertiary" : "bg-accent"}`}
            style={i === 0 ? undefined : { opacity: o }}
          />
        ))}
        More
      </div>
    </div>
  );
};

/** Episodes per calendar month (single series, accent bars with rounded tops on a shared baseline). */
const MonthBars: React.FC<{ months: { label: string; title: string; count: number; minutes: number }[] }> = ({
  months,
}) => {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...months.map((m) => m.count));
  return (
    <div>
      <div className="flex items-end gap-[2px] h-32 border-b border-border-subtle" onMouseLeave={() => setHover(null)}>
        {months.map((m, i) => (
          <div
            key={m.title}
            className="relative flex-1 h-full flex items-end justify-center"
            onMouseEnter={() => setHover(i)}
          >
            {hover === i && (
              <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 px-2 py-1 rounded-lg bg-bg-elevated border border-border-subtle text-[11px] text-text-primary whitespace-nowrap shadow-lg z-10 pointer-events-none">
                <span className="font-semibold">{m.count} eps</span>{" "}
                <span className="text-text-muted">
                  · {formatHours(m.minutes)} · {m.title}
                </span>
              </div>
            )}
            <div
              className={`w-full max-w-[28px] rounded-t bg-accent transition-opacity ${
                hover !== null && hover !== i ? "opacity-50" : ""
              }`}
              style={{ height: m.count ? `${Math.max(3, (m.count / max) * 100)}%` : 0 }}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-[2px] mt-1">
        {months.map((m) => (
          <div key={m.title} className="flex-1 text-center text-[10px] text-text-muted">
            {m.label}
          </div>
        ))}
      </div>
    </div>
  );
};

const PlayerList: React.FC<{ players: [string, number][] }> = ({ players }) => {
  const total = players.reduce((n, [, c]) => n + c, 0);
  if (total === 0) return <div className="text-xs text-text-muted">Nothing logged in the last year.</div>;
  return (
    <div className="space-y-2">
      {players.slice(0, 6).map(([name, count]) => (
        <div key={name} className="space-y-1">
          <div className="flex justify-between gap-2 text-xs">
            <span className="text-text-secondary truncate">{name}</span>
            <span className="font-semibold text-text-primary shrink-0">
              {count} <span className="font-normal text-text-muted">· {Math.round((count / total) * 100)}%</span>
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
            <div className="h-full rounded-full bg-accent" style={{ width: `${(count / total) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
};
