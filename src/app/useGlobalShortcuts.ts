import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AnimeEntry } from "@/lib/types";
import type { NavDirection } from "@/features/watchlist/VirtualWatchlist";
import { NAV_ITEMS, NavTab, SETTINGS_SHORTCUT_DIGIT } from "./nav";

interface ShortcutState {
  onWatchlist: boolean;
  drawerOpen: boolean;
  paletteOpen: boolean;
  signOutOpen: boolean;
  shortcutsOpen: boolean;
  settingsOpen: boolean;
  /** Update prompt or changelog */
  updateModalOpen: boolean;
  quickMenuOpen: boolean;
  selectedAnimeIds: number[];
  /** The watchlist's current rows (Ctrl+A; the top search result for Enter) */
  visibleAnime: AnimeEntry[];
  animeList: AnimeEntry[];
  /** The watchlist search box (type-to-search, Esc, ↓ / Enter while it has focus) */
  getSearchInput: () => HTMLInputElement | null;
  searchQuery: string;
  /** `visibleAnime` already reflects `searchQuery` (the results are computed from a deferred value) */
  searchSettled: boolean;
  setSearchQuery: (update: (prev: string) => string) => void;
  togglePalette: () => void;
  closePalette: () => void;
  closeSignOut: () => void;
  closeUpdateModal: () => void;
  openShortcuts: () => void;
  closeShortcuts: () => void;
  closeSettings: () => void;
  closeQuickMenu: () => void;
  closeDrawer: () => void;
  openAnime: (anime: AnimeEntry) => void;
  setSelectedAnimeIds: (ids: number[]) => void;
  /** Move the selection (and focus) between cards; false when there is no card that way */
  moveSelection: (dir: NavDirection) => boolean;
  /** Focus the selected card, or select the first one; false when the list is empty */
  enterList: () => boolean;
  navigate: (tab: NavTab) => void;
  openSettings: () => void;
  rescanLibrary: () => void;
}

const ARROWS: Record<string, NavDirection> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/**
 * F5 rescan (and never reload the webview), F11 fullscreen, Ctrl+K palette, Ctrl+1–8 tabs (sidebar order),
 * Ctrl+9 Settings, ? shortcuts sheet.
 *
 * Watchlist: focus decides what keys do. In the search box keys edit text, except ↓ (moves focus to
 * the selected / first card) and Enter (opens the selected anime, else the top result). On the
 * list, arrows move the selection and focus with it, Enter opens it, Ctrl+A selects all, typing
 * goes back to the search box with that character, Backspace goes back and deletes one, and ↑ on
 * the first row goes back. Escape peels one layer: modal → palette → Settings → quick menu → drawer → (on the
 * list during a search) back to the search box, deselecting → selection → search text → search
 * focus. Keep `SHORTCUT_GROUPS` (shortcuts.ts) in step with this.
 */
async function toggleFullscreen() {
  const win = getCurrentWindow();
  try {
    await win.setFullscreen(!(await win.isFullscreen()));
  } catch (err) {
    console.error("Fullscreen toggle failed:", err);
  }
}

export function useGlobalShortcuts(state: ShortcutState) {
  const ref = useRef(state);
  ref.current = state;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const s = ref.current;
      // Mounted only while the watchlist is shown
      const searchInput = s.getSearchInput();
      const target = e.target as HTMLElement | null;
      const isInputFocused =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      const ctrl = e.ctrlKey || e.metaKey;
      const anyModifier = ctrl || e.altKey;
      const layerOpen = s.drawerOpen || s.paletteOpen || s.signOutOpen || s.shortcutsOpen || s.settingsOpen;
      const listFocused = !isInputFocused && s.onWatchlist && !layerOpen;
      const searchFocused =
        s.onWatchlist && !layerOpen && searchInput !== null && target === searchInput;

      // Back to the search box from the list (the selection is dropped: it belongs to the list)
      const backToSearch = (edit?: (q: string) => string) => {
        if (!searchInput) return;
        s.setSelectedAnimeIds([]);
        searchInput.focus();
        if (edit) s.setSearchQuery(edit);
      };

      if (e.key === "F5") {
        // Always swallow F5 so the webview never reloads; rescan when nothing else has focus
        e.preventDefault();
        if (!isInputFocused && !layerOpen) s.rescanLibrary();
      } else if (e.key === "F11") {
        e.preventDefault();
        if (!e.repeat) void toggleFullscreen();
      } else if (ctrl && !e.altKey && !e.shiftKey && /^(Digit|Numpad)[1-9]$/.test(e.code)) {
        // By physical key, so it works on every keyboard layout and inside text fields
        e.preventDefault();
        const digit = Number(e.code.slice(-1));
        if (s.signOutOpen) return;
        if (digit === SETTINGS_SHORTCUT_DIGIT) s.openSettings();
        else if (NAV_ITEMS[digit - 1]) s.navigate(NAV_ITEMS[digit - 1].id);
      } else if (ctrl && e.key.toLowerCase() === "k") {
        e.preventDefault();
        s.togglePalette();
      } else if (ctrl && e.key.toLowerCase() === "a" && listFocused) {
        e.preventDefault();
        s.setSelectedAnimeIds(s.visibleAnime.map((a) => a.id));
      } else if (e.key === "Enter" && (listFocused || searchFocused) && !s.quickMenuOpen) {
        const selected =
          s.selectedAnimeIds.length === 1 ? s.animeList.find((a) => a.id === s.selectedAnimeIds[0]) : undefined;
        // From the search box with nothing selected: the top result, once the results caught up
        const top =
          searchFocused && s.selectedAnimeIds.length === 0 && s.searchQuery.trim() && s.searchSettled
            ? s.visibleAnime[0]
            : undefined;
        const anime = selected ?? top;
        if (anime) {
          e.preventDefault();
          s.openAnime(anime);
        }
      } else if (searchFocused && e.key === "ArrowDown" && !anyModifier && !e.shiftKey && !s.quickMenuOpen) {
        e.preventDefault();
        s.enterList();
      } else if (listFocused && e.key in ARROWS && !anyModifier && !e.shiftKey && !s.quickMenuOpen) {
        e.preventDefault();
        const moved = s.moveSelection(ARROWS[e.key]);
        // ↑ past the first row goes back to the search box
        if (!moved && e.key === "ArrowUp") backToSearch();
      } else if (e.key === "?" && !isInputFocused && !layerOpen && !s.quickMenuOpen) {
        e.preventDefault();
        s.openShortcuts();
      } else if (listFocused && !s.quickMenuOpen && !anyModifier && e.key === "Backspace" && s.searchQuery) {
        e.preventDefault();
        backToSearch((q) => q.slice(0, -1));
      } else if (
        listFocused &&
        !s.quickMenuOpen &&
        !anyModifier &&
        e.key.length === 1 &&
        e.key !== " " &&
        searchInput
      ) {
        // Type-to-search: the first character lands in the box, the rest are typed into it
        e.preventDefault();
        const ch = e.key;
        backToSearch((q) => q + ch);
      } else if (e.key === "Escape") {
        if (s.updateModalOpen) s.closeUpdateModal();
        else if (s.signOutOpen) s.closeSignOut();
        else if (s.shortcutsOpen) s.closeShortcuts();
        else if (s.paletteOpen) s.closePalette();
        else if (s.settingsOpen) s.closeSettings();
        else if (s.quickMenuOpen) s.closeQuickMenu();
        else if (s.drawerOpen) s.closeDrawer();
        else if (listFocused && s.searchQuery) backToSearch();
        else if (s.selectedAnimeIds.length > 0) s.setSelectedAnimeIds([]);
        else if (s.onWatchlist && s.searchQuery) s.setSearchQuery(() => "");
        else if (searchFocused) searchInput?.blur();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
