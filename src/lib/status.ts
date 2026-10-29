import type { LucideIcon } from "lucide-react";
import { CheckCircle2, Clock, PauseCircle, RotateCcw, Tv, XCircle } from "lucide-react";

/** Display data for one AniList list status; the one place labels and colors are defined. */
export interface ListStatusInfo {
  id: string;
  /** Menus, tabs, search groups */
  label: string;
  /** Badges and charts */
  shortLabel: string;
  icon: LucideIcon;
  /** Icon text color */
  color: string;
  /** Solid badge (background + text) */
  badge: string;
  /** Stats chart color */
  chart: string;
}

/** Menu order (quick menus, palette, filters) */
export const LIST_STATUSES: ListStatusInfo[] = [
  { id: "CURRENT", label: "Watching", shortLabel: "Watching", icon: Tv, color: "text-accent", badge: "bg-accent text-white", chart: "var(--stat-current)" },
  { id: "PLANNING", label: "Plan to Watch", shortLabel: "Planning", icon: Clock, color: "text-sky-400", badge: "bg-sky-500 text-white", chart: "var(--stat-planning)" },
  { id: "COMPLETED", label: "Completed", shortLabel: "Completed", icon: CheckCircle2, color: "text-emerald-400", badge: "bg-emerald-500 text-white", chart: "var(--stat-completed)" },
  { id: "PAUSED", label: "Paused", shortLabel: "Paused", icon: PauseCircle, color: "text-amber-400", badge: "bg-amber-500 text-black", chart: "var(--stat-paused)" },
  { id: "DROPPED", label: "Dropped", shortLabel: "Dropped", icon: XCircle, color: "text-rose-400", badge: "bg-rose-500 text-white", chart: "var(--stat-dropped)" },
  { id: "REPEATING", label: "Rewatching", shortLabel: "Rewatching", icon: RotateCcw, color: "text-violet-400", badge: "bg-violet-500 text-white", chart: "var(--stat-repeating)" },
];

export const STATUS_INFO: Record<string, ListStatusInfo> = Object.fromEntries(
  LIST_STATUSES.map((s) => [s.id, s])
);

export const statusLabel = (status: string) => STATUS_INFO[status]?.label ?? status;

/** Watchlist status tabs; Rewatching has none of its own (All Anime and search show it) */
export const WATCHLIST_TABS = [
  ...["CURRENT", "PLANNING", "COMPLETED", "PAUSED", "DROPPED"].map((id) => ({ id, label: STATUS_INFO[id].label })),
  { id: "ALL", label: "All Anime" },
];

/** Section order while the watchlist search groups matches from every list by status */
export const SEARCH_GROUP_ORDER = ["CURRENT", "REPEATING", "PLANNING", "COMPLETED", "PAUSED", "DROPPED"];
