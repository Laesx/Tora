import { useEffect, useRef } from "react";
import { AnimeEntry } from "@/lib/types";

interface ShortcutState {
  onWatchlist: boolean;
  drawerOpen: boolean;
  paletteOpen: boolean;
  signOutOpen: boolean;
  quickMenuOpen: boolean;
  selectedAnimeIds: number[];
  /** The watchlist's current rows (Ctrl+A) */
  visibleAnime: AnimeEntry[];
  animeList: AnimeEntry[];
  togglePalette: () => void;
  closePalette: () => void;
  closeSignOut: () => void;
  closeQuickMenu: () => void;
  closeDrawer: () => void;
  openAnime: (anime: AnimeEntry) => void;
  setSelectedAnimeIds: (ids: number[]) => void;
  rescanLibrary: () => void;
}

/**
 * F5 rescan (and never reload the webview), Ctrl+K palette, Ctrl+A select all in the watchlist,
 * Enter opens the single selected anime, Escape closes the topmost layer or clears the selection.
 */
export function useGlobalShortcuts(state: ShortcutState) {
  const ref = useRef(state);
  ref.current = state;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const s = ref.current;
      const target = e.target as HTMLElement | null;
      const isInputFocused =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      const listFocused = !isInputFocused && s.onWatchlist && !s.drawerOpen && !s.paletteOpen;

      if (e.key === "F5") {
        // Always swallow F5 so the webview never reloads; rescan when nothing else has focus
        e.preventDefault();
        if (!isInputFocused && !s.drawerOpen && !s.paletteOpen && !s.signOutOpen) s.rescanLibrary();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        s.togglePalette();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && listFocused) {
        e.preventDefault();
        s.setSelectedAnimeIds(s.visibleAnime.map((a) => a.id));
      } else if (e.key === "Enter" && listFocused && !s.quickMenuOpen && s.selectedAnimeIds.length === 1) {
        const found = s.animeList.find((a) => a.id === s.selectedAnimeIds[0]);
        if (found) {
          e.preventDefault();
          s.openAnime(found);
        }
      } else if (e.key === "Escape") {
        if (s.signOutOpen) s.closeSignOut();
        else if (s.paletteOpen) s.closePalette();
        else if (s.quickMenuOpen) s.closeQuickMenu();
        else if (s.drawerOpen) s.closeDrawer();
        else if (s.selectedAnimeIds.length > 0) s.setSelectedAnimeIds([]);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
