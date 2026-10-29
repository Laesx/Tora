import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BarChart3,
  CalendarClock,
  CalendarDays,
  Compass,
  History,
  Magnet,
  Settings,
  Tv,
} from "lucide-react";

export type NavTab =
  | "watchlist"
  | "torrents"
  | "seasons"
  | "schedule"
  | "search"
  | "nowplaying"
  | "history"
  | "stats"
  | "settings";

export interface NavItem {
  id: NavTab;
  label: string;
  icon: LucideIcon;
  /** Extra command palette search words for "Go to <label>" */
  keywords: string[];
}

/** Every tab in sidebar order; Settings is the gear button, not a sidebar row */
export const NAV_ITEMS: NavItem[] = [
  { id: "nowplaying", label: "Now Playing", icon: Activity, keywords: ["playing", "player", "dashboard"] },
  { id: "watchlist", label: "Anime Watchlist", icon: Tv, keywords: ["list", "library"] },
  { id: "torrents", label: "Torrents & RSS", icon: Magnet, keywords: ["nyaa", "download", "rss", "feed"] },
  { id: "seasons", label: "Seasons", icon: CalendarDays, keywords: ["seasonal", "browse"] },
  { id: "schedule", label: "Schedule", icon: CalendarClock, keywords: ["airing", "calendar", "timetable"] },
  { id: "search", label: "Search", icon: Compass, keywords: ["anilist", "find"] },
  { id: "history", label: "History", icon: History, keywords: ["watched", "scrobbles"] },
  { id: "stats", label: "Stats", icon: BarChart3, keywords: ["statistics", "activity", "backlog"] },
  { id: "settings", label: "Settings", icon: Settings, keywords: ["preferences", "options"] },
];
