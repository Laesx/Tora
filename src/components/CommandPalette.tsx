import React, { useEffect, useMemo, useState } from "react";
import {
  Search,
  Play,
  Plus,
  HardDrive,
  Palette,
  Magnet,
  CornerDownLeft,
  X,
} from "lucide-react";
import { AnimeEntry } from "../types";
import { THEME_PRESETS } from "../api";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  animeList: AnimeEntry[];
  onSelectAnime: (anime: AnimeEntry) => void;
  onIncrementAnime: (anime: AnimeEntry) => void;
  onNavigateTab: (tab: any) => void;
  onScanDrives: () => void;
  onSwitchTheme: (themeId: string, accent: string) => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onClose,
  animeList,
  onSelectAnime,
  onIncrementAnime,
  onNavigateTab,
  onScanDrives,
  onSwitchTheme,
}) => {
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const matchingAnime = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return animeList.slice(0, 5);
    return animeList
      .filter(
        (a) =>
          a.title_romaji.toLowerCase().includes(q) ||
          (a.title_english && a.title_english.toLowerCase().includes(q)) ||
          a.synonyms.some((s) => s.toLowerCase().includes(q))
      )
      .slice(0, 6);
  }, [animeList, query]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-bg-secondary border border-border-subtle rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-border-subtle">
          <Search className="w-4 h-4 text-accent shrink-0" />
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to anime, increment episode, switch theme, or run command..."
            className="flex-1 bg-transparent text-xs text-text-primary focus:outline-none"
          />
          <button
            onClick={onClose}
            className="p-1 rounded text-text-muted hover:text-text-primary"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="max-h-96 overflow-y-auto p-2 space-y-3 text-xs">
          {/* Anime Quick Matches */}
          <div>
            <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              Anime Watchlist
            </div>
            {matchingAnime.map((a) => (
              <div
                key={a.id}
                onClick={() => {
                  onSelectAnime(a);
                  onClose();
                }}
                className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl hover:bg-bg-tertiary cursor-pointer transition"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <img
                    src={a.cover_image}
                    alt={a.title_romaji}
                    className="w-7 h-10 object-cover rounded shrink-0"
                  />
                  <div className="min-w-0">
                    <div className="font-semibold text-text-primary truncate">
                      {a.title_romaji}
                    </div>
                    <div className="text-[10px] text-text-muted font-mono">
                      {a.user_status} • Ep {a.user_progress}/{a.episodes ?? "?"}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onIncrementAnime(a);
                      onClose();
                    }}
                    className="px-2 py-1 rounded bg-accent/20 hover:bg-accent text-accent hover:text-white font-mono text-[10px] font-semibold transition flex items-center gap-1"
                  >
                    <Plus className="w-3 h-3" />1 Ep
                  </button>
                  <CornerDownLeft className="w-3.5 h-3.5 text-text-muted" />
                </div>
              </div>
            ))}
          </div>

          {/* Quick Actions */}
          <div>
            <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              Quick Actions & Themes
            </div>
            <button
              onClick={() => {
                onScanDrives();
                onClose();
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-bg-tertiary text-left text-text-primary transition"
            >
              <HardDrive className="w-4 h-4 text-accent" />
              <span>Rescan All Multi-Drive Library Folders</span>
            </button>
            <button
              onClick={() => {
                onNavigateTab("torrents");
                onClose();
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-bg-tertiary text-left text-text-primary transition"
            >
              <Magnet className="w-4 h-4 text-accent" />
              <span>Open Torrent Search & RSS Filters</span>
            </button>

            <div className="grid grid-cols-3 gap-1.5 px-2 pt-1.5">
              {THEME_PRESETS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    onSwitchTheme(t.id, t.defaultAccent);
                    onClose();
                  }}
                  className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-bg-primary hover:bg-bg-tertiary border border-border-subtle text-[11px] text-text-secondary hover:text-text-primary transition"
                >
                  <Palette className="w-3 h-3 text-accent shrink-0" />
                  <span className="truncate">{t.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
