import { Download, HardDrive, Keyboard, LayoutGrid, List, ListChecks, Palette, RefreshCw, Rows, ScrollText, Settings, Shuffle } from "lucide-react";
import { THEME_PRESETS } from "@/lib/theme";
import type { PaletteCommand } from "@/features/palette/CommandPalette";
import type { ViewMode } from "@/features/watchlist/WatchlistView";
import { NAV_ITEMS, NavTab } from "./nav";

interface PaletteCommandDeps {
  navigate: (tab: NavTab) => void;
  openTorrentSettings: () => void;
  rescanLibrary: () => void;
  syncFromAnilist: () => void;
  openRandomAnime: () => void;
  openShortcuts: () => void;
  checkForUpdates: () => void;
  openChangelog: () => void;
  customListNames: string[];
  openCustomList: (name: string) => void;
  setViewMode: (mode: ViewMode) => void;
  setTheme: (themeId: string, accent: string) => void;
}

/** Every command in the Ctrl+K Commands tab, in display order. */
export function buildPaletteCommands(d: PaletteCommandDeps): PaletteCommand[] {
  return [
    ...NAV_ITEMS.map((item, i) => ({
      id: `go-${item.id}`,
      label: `Go to ${item.label}`,
      keywords: item.keywords,
      icon: item.icon,
      shortcut: `Ctrl+${i + 1}`,
      run: () => d.navigate(item.id),
    })),
    { id: "torrent-settings", label: "Torrent settings", keywords: ["qbittorrent", "download folder", "refresh interval", "torrents"], icon: Settings, run: d.openTorrentSettings },
    { id: "rescan-library", label: "Rescan All Library Folders", keywords: ["scan", "refresh", "files", "disk"], icon: HardDrive, shortcut: "F5", run: d.rescanLibrary },
    { id: "sync-anilist", label: "Sync from AniList", keywords: ["pull", "refresh", "tracker"], icon: RefreshCw, run: d.syncFromAnilist },
    { id: "shortcuts", label: "Keyboard Shortcuts", keywords: ["keys", "hotkeys", "help", "keyboard"], icon: Keyboard, shortcut: "?", run: d.openShortcuts },
    { id: "check-updates", label: "Check for Updates", keywords: ["update", "upgrade", "version", "relations", "github"], icon: Download, run: d.checkForUpdates },
    { id: "changelog", label: "What's New (Changelog)", keywords: ["release notes", "version", "updates", "changes"], icon: ScrollText, run: d.openChangelog },
    { id: "random-anime", label: "Open a Random Anime from the Current List", keywords: ["shuffle", "pick", "random"], icon: Shuffle, run: d.openRandomAnime },
    ...d.customListNames.map((name) => ({
      id: `custom-list-${name}`,
      label: `Open List: ${name}`,
      keywords: ["custom list", "anilist list"],
      icon: ListChecks,
      run: () => d.openCustomList(name),
    })),
    { id: "view-grid", label: "View: Poster Grid", keywords: ["layout", "cards"], icon: LayoutGrid, run: () => d.setViewMode("grid") },
    { id: "view-compact", label: "View: Detailed Cards", keywords: ["layout", "compact"], icon: Rows, run: () => d.setViewMode("compact") },
    { id: "view-table", label: "View: Dense Table", keywords: ["layout", "list", "taiga"], icon: List, run: () => d.setViewMode("table") },
    ...THEME_PRESETS.map((t) => ({
      id: `theme-${t.id}`,
      label: `Theme: ${t.name}`,
      keywords: ["theme", "appearance", "color", t.isDark ? "dark" : "light"],
      icon: Palette,
      run: () => d.setTheme(t.id, t.defaultAccent),
    })),
  ];
}
