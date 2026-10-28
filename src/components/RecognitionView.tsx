import React, { useEffect, useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  Clock,
  Tv,
  History,
  Link2,
  AlertTriangle,
  Search,
} from "lucide-react";
import {
  AnimeEntry,
  AppSettings,
  DetectedMediaSession,
  WatchHistoryEntry,
} from "../types";
import { getOptimizedCoverUrl, toraApi } from "../api";

interface RecognitionViewProps {
  activeSession: DetectedMediaSession | null;
  animeList: AnimeEntry[];
  settings: AppSettings;
  onUpdateSettings: (next: AppSettings) => Promise<void>;
  onLinkDetectedEpisode: (animeId: number, aliasTitle: string) => Promise<void>;
  showToast: (msg: string, type?: "success" | "info" | "error") => void;
}

export const RecognitionView: React.FC<RecognitionViewProps> = ({
  activeSession,
  animeList,
  settings,
  onUpdateSettings,
  onLinkDetectedEpisode,
  showToast,
}) => {
  const [history, setHistory] = useState<WatchHistoryEntry[]>([]);
  const [animeSearch, setAnimeSearch] = useState("");
  const [selectedAnimeId, setSelectedAnimeId] = useState<number | null>(null);
  const [isRelinking, setIsRelinking] = useState(false);
  const [linkingBusy, setLinkingBusy] = useState(false);

  const loadHistory = async () => {
    try {
      const h = await toraApi.getWatchHistory();
      setHistory(h);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    loadHistory();
  }, [activeSession?.auto_synced]);

  // Reset relinking state when detected media changes
  useEffect(() => {
    setIsRelinking(false);
    setSelectedAnimeId(activeSession?.matched_anime_id ?? null);
  }, [activeSession?.cleaned_media_title, activeSession?.matched_anime_id]);

  const filteredAnimeChoices = useMemo(() => {
    const q = animeSearch.trim().toLowerCase();
    const list = !q
      ? animeList
      : animeList.filter(
        (a) =>
          a.title_romaji.toLowerCase().includes(q) ||
          (a.title_english && a.title_english.toLowerCase().includes(q)) ||
          a.synonyms.some((s) => s.toLowerCase().includes(q))
      );
    return list.slice(0, 48);
  }, [animeList, animeSearch]);

  const showAnimeSelector =
    activeSession !== null && (!activeSession.matched_anime_id || isRelinking);

  const handleConfirmLink = async () => {
    if (!activeSession || !selectedAnimeId) return;
    const aliasToSave =
      activeSession.parsed.anime_title.trim() ||
      activeSession.cleaned_media_title.trim();
    if (!aliasToSave) return;

    setLinkingBusy(true);
    try {
      await onLinkDetectedEpisode(selectedAnimeId, aliasToSave);
      setIsRelinking(false);
      showToast(
        `Saved relation "${aliasToSave}" — subsequent episodes will match automatically!`,
        "success"
      );
    } catch (err: any) {
      showToast(String(err), "error");
    } finally {
      setLinkingBusy(false);
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-text-primary flex items-center gap-2.5">
            <Activity className="w-6 h-6 text-accent" />
            Episode Detection
          </h1>
          <p className="text-xs text-text-secondary mt-0.5">
            Real-time media player detection & automatic progress tracking. Unmatched titles pause auto-update and prompt you to link the anime once.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-bg-secondary border border-border-subtle text-xs font-medium cursor-pointer">
            <input
              type="checkbox"
              checked={settings.recognition_enabled}
              onChange={(e) =>
                onUpdateSettings({
                  ...settings,
                  recognition_enabled: e.target.checked,
                })
              }
              className="rounded accent-accent"
            />
            <span>Live Win32 Player Detection</span>
          </label>
        </div>
      </div>

      {/* Live Active Session Status Card */}
      <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
            <Tv className="w-4 h-4 text-accent" />
            Active Media Player Session
          </h2>
          {activeSession ? (
            <div className="flex items-center gap-2">
              {activeSession.matched_anime_id && !isRelinking && (
                <button
                  onClick={() => setIsRelinking(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-bg-tertiary hover:bg-bg-elevated text-text-secondary hover:text-text-primary text-xs font-semibold transition"
                >
                  <Link2 className="w-3.5 h-3.5" />
                  Change Linked Anime
                </button>
              )}
            </div>
          ) : (
            <span className="text-xs text-text-muted flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              Polling Windows media players every 2s...
            </span>
          )}
        </div>

        {activeSession ? (
          <div className="space-y-4">
            <div
              className={`flex flex-wrap items-center gap-5 p-4 rounded-xl bg-bg-primary border ${activeSession.matched_anime_id
                  ? "border-accent/40"
                  : "border-amber-500/50"
                }`}
            >
              {activeSession.matched_cover_image && (
                <img
                  src={getOptimizedCoverUrl(
                    activeSession.matched_cover_image,
                    "medium"
                  )}
                  alt={activeSession.matched_anime_title || ""}
                  decoding="async"
                  className="w-16 h-24 object-cover rounded-lg border border-border-subtle shrink-0"
                />
              )}
              <div className="flex-1 min-w-[240px] space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="px-2 py-0.5 rounded bg-accent text-white text-[11px] font-bold">
                    {activeSession.player_name} (PID {activeSession.process_id})
                  </span>

                  {activeSession.matched_anime_id ? (
                    activeSession.auto_synced ? (
                      <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 text-[11px] font-semibold flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Progress Updated!
                      </span>
                    ) : activeSession.parsed.episode_number !== null &&
                      activeSession.matched_current_progress !== null &&
                      activeSession.parsed.episode_number <=
                      activeSession.matched_current_progress ? null : (
                      <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[11px] font-mono flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5" />
                        Updating in{" "}
                        {Math.max(
                          0,
                          settings.recognition_delay_seconds -
                          activeSession.elapsed_seconds
                        )}
                        s
                      </span>
                    )
                  ) : (
                    <span className="px-2.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[11px] font-semibold flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      Unmatched Anime
                    </span>
                  )}
                </div>

                <div className="text-base font-bold text-text-primary">
                  {activeSession.matched_anime_title ||
                    activeSession.parsed.anime_title}{" "}
                  {activeSession.parsed.anime_season
                    ? `(Season ${activeSession.parsed.anime_season}) `
                    : ""}
                  — Episode {activeSession.parsed.episode_number ?? "?"}
                </div>

                <div className="text-xs font-mono text-text-muted truncate">
                  Window Title: {activeSession.raw_window_title}
                </div>
              </div>
            </div>

            {/* Prompt User to Select Anime & Save Relation when Unmatched (or Relinking) */}
            {showAnimeSelector && (
              <div className="p-4 rounded-xl bg-bg-primary border border-amber-500/40 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-xs font-bold text-amber-300 flex items-center gap-1.5">
                      <Link2 className="w-4 h-4" />
                      {activeSession.matched_anime_id
                        ? "Change Linked Anime Entry"
                        : "Select Which Anime This Episode Belongs To"}
                    </h3>
                    <p className="text-[11px] text-text-secondary mt-0.5">
                      Link{" "}
                      <span className="font-mono text-text-primary font-semibold">
                        "{activeSession.parsed.anime_title}"
                      </span>{" "}
                      to an entry in your library. Tora will save this relation on the anime so all subsequent episodes match automatically.
                    </p>
                  </div>
                  {isRelinking && (
                    <button
                      onClick={() => setIsRelinking(false)}
                      className="px-2.5 py-1 rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary text-xs"
                    >
                      Cancel
                    </button>
                  )}
                </div>

                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-text-muted absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={animeSearch}
                    onChange={(e) => setAnimeSearch(e.target.value)}
                    placeholder="Search your anime list by title or alternative name..."
                    className="w-full pl-8 pr-3 py-2 rounded-xl bg-bg-secondary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-60 overflow-y-auto pr-1">
                  {filteredAnimeChoices.map((anime) => {
                    const isSelected = selectedAnimeId === anime.id;
                    return (
                      <button
                        key={anime.id}
                        type="button"
                        onClick={() => setSelectedAnimeId(anime.id)}
                        className={`flex items-center gap-3 p-2.5 rounded-xl border text-left transition ${isSelected
                            ? "bg-accent/20 border-accent text-text-primary"
                            : "bg-bg-secondary border-border-subtle text-text-secondary hover:text-text-primary hover:border-border-subtle/80"
                          }`}
                      >
                        <img
                          src={getOptimizedCoverUrl(anime.cover_image, "medium")}
                          alt={anime.title_romaji}
                          loading="lazy"
                          decoding="async"
                          className="w-9 h-12 object-cover rounded-md shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-bold text-text-primary truncate">
                            {anime.title_romaji}
                          </div>
                          {anime.title_english && (
                            <div className="text-[10px] text-text-muted truncate">
                              {anime.title_english}
                            </div>
                          )}
                          <div className="text-[10px] font-mono text-accent mt-0.5">
                            Ep {anime.user_progress}/{anime.episodes ?? "?"} ·{" "}
                            {anime.user_status}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    disabled={!selectedAnimeId || linkingBusy}
                    onClick={handleConfirmLink}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-accent hover:bg-accent-hover disabled:opacity-40 text-white text-xs font-bold transition"
                  >
                    <Link2 className="w-3.5 h-3.5" />
                    {linkingBusy
                      ? "Saving Relation..."
                      : "Link Anime & Save Relation for Subsequent Episodes"}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="p-5 rounded-xl bg-bg-primary/60 border border-border-subtle text-xs text-text-secondary">
            Open any video file in{" "}
            <strong className="text-text-primary">
              mpv, VLC, MPC-HC, MPC-BE, or PotPlayer
            </strong>{" "}
            to detect playback automatically. Use{" "}
            <strong className="text-accent">Settings → Diagnostics</strong> to inspect how filenames are parsed.
          </div>
        )}
      </div>

      {/* Scrobble & Watch History */}
      <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-3">
        <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
          <History className="w-4 h-4 text-accent" />
          Recent Recognition & Scrobble History
        </h2>

        {history.length === 0 ? (
          <div className="py-12 text-center text-xs text-text-muted">
            No episodes scrobbled yet. Play an episode in your media player to start tracking!
          </div>
        ) : (
          <div className="divide-y divide-border-subtle max-h-96 overflow-y-auto pr-1">
            {history.map((h) => (
              <div
                key={h.id}
                className="py-2.5 flex items-center justify-between gap-3 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-semibold text-text-primary truncate">
                    {h.anime_title}{" "}
                    <span className="text-accent font-mono">
                      Ep {h.episode_number}
                    </span>
                  </div>
                  <div className="text-[11px] text-text-muted font-mono truncate">
                    {h.player_name} • {h.file_name}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <span className="text-[10px] font-mono text-text-muted block">
                    {new Date(h.timestamp_unix * 1000).toLocaleTimeString()}
                  </span>
                  {h.scrobbled_to_tracker && (
                    <span className="text-[10px] text-emerald-400 font-semibold">
                      Synced
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
