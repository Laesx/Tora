import { AnimeEntry } from "@/lib/types";
import { latestAiredEpisode } from "@/lib/episodes";
import { SEASONS } from "@/lib/seasons";

export type WatchlistSortKey =
  | "updated"
  | "title"
  | "score"
  | "started"
  | "completed"
  | "progress"
  | "progress_pct"
  | "remaining"
  | "ready"
  | "behind"
  | "next_airing"
  | "average_score"
  | "start_date"
  | "season"
  | "episodes"
  | "format";

export type SortDir = "asc" | "desc";

/** Values that a pending +1 / -1 must not move (the stepper's snapshot), plus the display title */
export interface SortContext {
  progress: number;
  updatedAt: number;
  title: string;
}

interface SortOption {
  id: WatchlistSortKey;
  label: string;
  group: "My list" | "Progress" | "Airing";
  defaultDir: SortDir;
  /** `null` = unknown, always sorted last whatever the direction */
  value: (a: AnimeEntry, c: SortContext) => number | string | null;
}

const SEASON_INDEX = new Map<string, number>(SEASONS.map((s, i) => [s, i]));

/** Every watchlist sort, in dropdown order (grouped by `group`). */
export const SORT_OPTIONS: SortOption[] = [
  { id: "updated", label: "Last updated", group: "My list", defaultDir: "desc", value: (_, c) => c.updatedAt || null },
  { id: "title", label: "Title", group: "My list", defaultDir: "asc", value: (_, c) => c.title },
  { id: "score", label: "My score", group: "My list", defaultDir: "desc", value: (a) => (a.user_score > 0 ? a.user_score : null) },
  { id: "started", label: "Date started", group: "My list", defaultDir: "desc", value: (a) => a.user_started_at || null },
  { id: "completed", label: "Date completed", group: "My list", defaultDir: "desc", value: (a) => a.user_completed_at || null },

  { id: "progress", label: "Episodes watched", group: "Progress", defaultDir: "desc", value: (_, c) => c.progress },
  {
    id: "progress_pct",
    label: "Progress %",
    group: "Progress",
    defaultDir: "desc",
    value: (a, c) => (a.episodes ? c.progress / a.episodes : null),
  },
  {
    id: "remaining",
    label: "Episodes left",
    group: "Progress",
    defaultDir: "asc",
    value: (a, c) => (a.episodes ? Math.max(0, a.episodes - c.progress) : null),
  },
  {
    id: "ready",
    label: "Ready to watch (on disk)",
    group: "Progress",
    defaultDir: "desc",
    value: (a, c) => (a.available_episodes ?? []).filter((ep) => ep > c.progress).length,
  },
  {
    id: "behind",
    label: "Aired, not watched",
    group: "Progress",
    defaultDir: "desc",
    value: (a, c) => {
      const aired = latestAiredEpisode(a);
      return aired === null ? null : Math.max(0, aired - c.progress);
    },
  },

  { id: "next_airing", label: "Next episode airs", group: "Airing", defaultDir: "asc", value: (a) => a.next_airing_at || null },
  { id: "average_score", label: "AniList score", group: "Airing", defaultDir: "desc", value: (a) => a.average_score || null },
  { id: "start_date", label: "Airing start date", group: "Airing", defaultDir: "desc", value: (a) => a.start_date || null },
  {
    id: "season",
    label: "Season",
    group: "Airing",
    defaultDir: "desc",
    value: (a) => (a.season_year ? a.season_year * 4 + (SEASON_INDEX.get(a.season ?? "") ?? 0) : null),
  },
  { id: "episodes", label: "Total episodes", group: "Airing", defaultDir: "desc", value: (a) => a.episodes || null },
  { id: "format", label: "Format", group: "Airing", defaultDir: "asc", value: (a) => a.format || null },
];

const OPTIONS_BY_ID = new Map(SORT_OPTIONS.map((o) => [o.id, o]));

export const isSortKey = (key: unknown): key is WatchlistSortKey =>
  typeof key === "string" && OPTIONS_BY_ID.has(key as WatchlistSortKey);

export const defaultSortDir = (key: WatchlistSortKey): SortDir => OPTIONS_BY_ID.get(key)!.defaultDir;

/** Comparator for `key` / `dir`: unknown values last, then title A–Z as the tie-break. */
export function watchlistComparator(
  key: WatchlistSortKey,
  dir: SortDir,
  context: (a: AnimeEntry) => SortContext
): (a: AnimeEntry, b: AnimeEntry) => number {
  const option = OPTIONS_BY_ID.get(key)!;
  const sign = dir === "asc" ? 1 : -1;
  return (a, b) => {
    const ca = context(a);
    const cb = context(b);
    const x = option.value(a, ca);
    const y = option.value(b, cb);
    let res = 0;
    if (x === null || y === null) res = x === y ? 0 : x === null ? 1 : -1;
    else if (typeof x === "number" && typeof y === "number") res = sign * (x - y);
    else res = sign * String(x).localeCompare(String(y));
    return res || (key === "title" ? 0 : ca.title.localeCompare(cb.title));
  };
}
