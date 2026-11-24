import type { LucideIcon } from "lucide-react";
import type { TrackerFeature } from "@/lib/types";
import {
  Activity,
  BarChart3,
  CalendarClock,
  CalendarDays,
  Compass,
  History,
  Magnet,
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
  | "stats";

export interface NavItem {
  id: NavTab;
  label: string;
  icon: LucideIcon;
  /** Extra command palette search words for "Go to <label>" */
  keywords: string[];
  /** The tracker feature the tab needs, and why it is off without it ("<tracker> has no airing schedule") */
  needs?: { feature: TrackerFeature; missing: string };
}

/** Every tab in sidebar order (Ctrl+1–8). Settings is a modal, not a tab: see `SETTINGS_SHORTCUT_DIGIT`. */
export const NAV_ITEMS: NavItem[] = [
  { id: "nowplaying", label: "Now Playing", icon: Activity, keywords: ["playing", "player", "dashboard"] },
  { id: "watchlist", label: "Anime List", icon: Tv, keywords: ["list", "library"] },
  { id: "torrents", label: "Torrents", icon: Magnet, keywords: ["nyaa", "download", "rss", "feed"] },
  { id: "seasons", label: "Seasons", icon: CalendarDays, keywords: ["seasonal", "browse"] },
  {
    id: "schedule",
    label: "Schedule",
    icon: CalendarClock,
    keywords: ["airing", "calendar", "timetable"],
    needs: { feature: "airing_schedule", missing: "has no airing schedule" },
  },
  { id: "search", label: "Search", icon: Compass, keywords: ["anilist", "find"] },
  { id: "history", label: "History", icon: History, keywords: ["watched", "scrobbles"] },
  { id: "stats", label: "Stats", icon: BarChart3, keywords: ["statistics", "activity", "backlog"] },
];

/** Whether `tab` works with the active tracker (`supports` from `useTracker`). */
export const tabAvailable = (tab: NavTab, supports: (feature: TrackerFeature) => boolean) => {
  const needs = NAV_ITEMS.find((item) => item.id === tab)?.needs;
  return !needs || supports(needs.feature);
};

/** Ctrl+<this> opens the Settings modal (the digit after the last tab) */
export const SETTINGS_SHORTCUT_DIGIT = NAV_ITEMS.length + 1;
