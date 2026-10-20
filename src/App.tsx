import React, { useEffect, useMemo, useState } from "react";
import {
  Tv,
  HardDrive,
  Magnet,
  Compass,
  Activity,
  Settings,
  Search,
  LayoutGrid,
  List,
  Rows,
  Plus,
  Minus,
  Play,
  Star,
  Clock,
  MoreHorizontal,
  Sparkles,
  CheckCircle2,
  Command as CommandIcon,
  RefreshCw,
  Shuffle,
  Palette,
} from "lucide-react";
import {
  AnimeEntry,
  AppSettings,
  DetectedMediaSession,
} from "./types";
import {
  THEME_PRESETS,
  applyThemeToDocument,
  formatCountdown,
  toraApi,
} from "./api";
import { AnimeDetailModal } from "./components/AnimeDetailModal";
import { AnimeQuickMenu } from "./components/AnimeQuickMenu";
import { LibraryManagerView } from "./components/LibraryManagerView";
import { TorrentsView } from "./components/TorrentsView";
import { RecognitionView } from "./components/RecognitionView";
import { DiscoverAndScheduleView } from "./components/DiscoverAndScheduleView";
import { SettingsAndPluginsView } from "./components/SettingsAndPluginsView";
import { CommandPalette } from "./components/CommandPalette";

type NavTab =
  | "watchlist"
  | "library"
  | "torrents"
  | "discover"
  | "recognition"
  | "settings";

const STATUS_TABS = [
  { id: "CURRENT", label: "Watching" },
  { id: "PLANNING", label: "Plan to Watch" },
  { id: "COMPLETED", label: "Completed" },
  { id: "PAUSED", label: "Paused" },
  { id: "DROPPED", label: "Dropped" },
  { id: "ALL", label: "All Anime" },
];

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<NavTab>("watchlist");
  const [statusFilter, setStatusFilter] = useState<string>("CURRENT");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<
    "updated" | "title" | "score" | "progress"
  >("updated");

  const [animeList, setAnimeList] = useState<AnimeEntry[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [selectedAnime, setSelectedAnime] = useState<AnimeEntry | null>(null);
  const [quickMenuAnimeId, setQuickMenuAnimeId] = useState<number | null>(null);
  const [torrentSearchQuery, setTorrentSearchQuery] = useState("");
  const [activeSession, setActiveSession] =
    useState<DetectedMediaSession | null>(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [toast, setToast] = useState<{
    msg: string;
    type: "success" | "info" | "error";
  } | null>(null);

  const showToast = (
    msg: string,
    type: "success" | "info" | "error" = "info"
  ) => {
    setToast({ msg, type });
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const loadInitialData = async () => {
    try {
      const [s, list] = await Promise.all([
        toraApi.getAppSettings(),
        toraApi.getAnimeList(),
      ]);
      setSettings(s);
      applyThemeToDocument(s.theme, s.accent_color);
      setAnimeList(list);
    } catch (e) {
      console.error("Failed to initialize Tora:", e);
    }
  };

  const refreshAnimeList = async (overrideList?: AnimeEntry[]) => {
    if (overrideList) {
      setAnimeList(overrideList);
      if (selectedAnime) {
        const found = overrideList.find((a) => a.id === selectedAnime.id);
        if (found) setSelectedAnime(found);
      }
      return;
    }
    const list = await toraApi.getAnimeList();
    setAnimeList(list);
    if (selectedAnime) {
      const found = list.find((a) => a.id === selectedAnime.id);
      if (found) setSelectedAnime(found);
    }
  };

  useEffect(() => {
    loadInitialData();
  }, []);

  // Poll Anisthesia Windows Media Player Recognition every 2.5 seconds without overlapping calls
  useEffect(() => {
    let inFlight = false;
    const interval = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const session = await toraApi.pollMediaRecognition();
        setActiveSession((prev) => {
          if (!prev && !session) return prev;
          // If auto_synced just flipped to true, refresh anime list and notify user
          if (session && session.auto_synced && (!prev || !prev.auto_synced)) {
            refreshAnimeList();
            showToast(
              `Scrobbled: ${
                session.matched_anime_title || session.parsed.anime_title
              } Episode ${session.parsed.episode_number ?? ""}!`,
              "success"
            );
          }
          return session;
        });
      } catch {
        // Ignore transient poll errors
      } finally {
        inFlight = false;
      }
    }, 2500);
    return () => clearInterval(interval);
  }, []);

  // Keyboard shortcuts: Ctrl+K for Command Palette, Escape to close modals/menus
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((prev) => !prev);
      } else if (e.key === "Escape") {
        setCmdOpen(false);
        setQuickMenuAnimeId(null);
        setSelectedAnime(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleUpdateSettings = async (next: AppSettings) => {
    setSettings(next);
    const saved = await toraApi.saveAppSettings(next);
    setSettings(saved);
  };

  const handleStepEpisode = async (anime: AnimeEntry, delta: number) => {
    const maxEp = anime.episodes || 9999;
    const nextProg = Math.max(0, Math.min(maxEp, anime.user_progress + delta));
    let nextStatus = anime.user_status;
    if (anime.episodes && nextProg >= anime.episodes) {
      nextStatus = "COMPLETED";
    } else if (nextProg > 0 && anime.user_status === "PLANNING") {
      nextStatus = "CURRENT";
    }

    // Instant 0ms optimistic UI update
    const optimisticEntry: AnimeEntry = {
      ...anime,
      user_progress: nextProg,
      user_status: nextStatus,
    };
    setAnimeList((prev) =>
      prev.map((a) => (a.id === anime.id ? optimisticEntry : a))
    );
    if (selectedAnime?.id === anime.id) {
      setSelectedAnime(optimisticEntry);
    }
    showToast(`${anime.title_romaji} → Episode ${nextProg}`, "success");

    try {
      const updated = await toraApi.updateAnimeEntry({
        animeId: anime.id,
        userStatus: nextStatus,
        userProgress: nextProg,
        userScore: anime.user_score,
        userRepeats: anime.user_repeats,
        userNotes: anime.user_notes,
        customFolder: anime.custom_folder,
      });
      setAnimeList((prev) =>
        prev.map((a) => (a.id === updated.id ? updated : a))
      );
      if (selectedAnime?.id === updated.id) {
        setSelectedAnime(updated);
      }
    } catch (err: any) {
      showToast(String(err), "error");
    }
  };

  const handleSimulatePlayback = async (
    playerName: string | null,
    windowTitle: string | null
  ) => {
    const session = await toraApi.simulatePlaybackSession(
      playerName,
      windowTitle
    );
    setActiveSession(session);
  };

  const handleCycleTheme = async () => {
    if (!settings) return;
    const idx = THEME_PRESETS.findIndex((t) => t.id === settings.theme);
    const nextPreset = THEME_PRESETS[(idx + 1) % THEME_PRESETS.length];
    applyThemeToDocument(nextPreset.id, nextPreset.defaultAccent);
    await handleUpdateSettings({
      ...settings,
      theme: nextPreset.id,
      accent_color: nextPreset.defaultAccent,
    });
    showToast(`Theme: ${nextPreset.name}`, "info");
  };

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { ALL: animeList.length };
    for (const a of animeList) {
      counts[a.user_status] = (counts[a.user_status] || 0) + 1;
    }
    return counts;
  }, [animeList]);

  const filteredAnime = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return animeList
      .filter((a) => {
        if (statusFilter !== "ALL" && a.user_status !== statusFilter) {
          return false;
        }
        if (q) {
          return (
            a.title_romaji.toLowerCase().includes(q) ||
            (a.title_english && a.title_english.toLowerCase().includes(q)) ||
            a.synonyms.some((s) => s.toLowerCase().includes(q)) ||
            a.genres.some((g) => g.toLowerCase().includes(q)) ||
            a.studios.some((st) => st.toLowerCase().includes(q))
          );
        }
        return true;
      })
      .sort((a, b) => {
        if (sortBy === "title")
          return a.title_romaji.localeCompare(b.title_romaji);
        if (sortBy === "score") return b.user_score - a.user_score;
        if (sortBy === "progress") return b.user_progress - a.user_progress;
        return b.updated_at - a.updated_at;
      });
  }, [animeList, statusFilter, searchQuery, sortBy]);

  const totalEpisodesWatched = useMemo(
    () => animeList.reduce((acc, a) => acc + a.user_progress, 0),
    [animeList]
  );

  const totalLocalFilesMatched = useMemo(
    () => animeList.reduce((acc, a) => acc + a.local_episode_count, 0),
    [animeList]
  );

  const viewMode = settings?.view_mode || "grid";

  return (
    <div
      className="flex h-screen w-screen overflow-hidden bg-bg-primary text-text-primary select-none"
      onClick={() => setQuickMenuAnimeId(null)}
    >
      {/* Left Sidebar Navigation */}
      <aside className="w-60 bg-bg-secondary border-r border-border-subtle flex flex-col justify-between shrink-0">
        <div className="p-4 space-y-5">
          {/* App Brand Header */}
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center text-white font-black text-lg shadow-md">
                虎
              </div>
              <div>
                <div className="font-extrabold text-sm tracking-tight text-text-primary flex items-center gap-1.5">
                  TORA
                  <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-accent/15 text-accent">
                    v0.1
                  </span>
                </div>
                <div className="text-[10px] text-text-muted">
                  Anime Library & Tracker
                </div>
              </div>
            </div>

            <button
              onClick={handleCycleTheme}
              className="p-2 rounded-lg bg-bg-tertiary hover:bg-bg-elevated text-text-secondary hover:text-accent transition"
              title="Cycle Theme"
            >
              <Palette className="w-4 h-4" />
            </button>
          </div>

          {/* Ctrl+K Quick Command Button */}
          <button
            onClick={() => setCmdOpen(true)}
            className="w-full flex items-center justify-between px-3 py-2 rounded-xl bg-bg-primary border border-border-subtle hover:border-accent/50 text-xs text-text-muted hover:text-text-primary transition"
          >
            <span className="flex items-center gap-2">
              <Search className="w-3.5 h-3.5 text-accent" />
              Quick Jump...
            </span>
            <kbd className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-bg-tertiary text-text-secondary">
              Ctrl+K
            </kbd>
          </button>

          {/* Primary Navigation Links */}
          <nav className="space-y-1">
            <button
              onClick={() => setActiveTab("watchlist")}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition ${
                activeTab === "watchlist"
                  ? "bg-accent text-white shadow-sm"
                  : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Tv className="w-4 h-4" />
                Anime Watchlist
              </span>
              <span className="text-[11px] font-mono opacity-80">
                {animeList.length}
              </span>
            </button>

            <button
              onClick={() => setActiveTab("library")}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition ${
                activeTab === "library"
                  ? "bg-accent text-white shadow-sm"
                  : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
              }`}
            >
              <span className="flex items-center gap-2.5">
                <HardDrive className="w-4 h-4" />
                Multi-Drive Library
              </span>
              {totalLocalFilesMatched > 0 && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                  {totalLocalFilesMatched}
                </span>
              )}
            </button>

            <button
              onClick={() => setActiveTab("torrents")}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition ${
                activeTab === "torrents"
                  ? "bg-accent text-white shadow-sm"
                  : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Magnet className="w-4 h-4" />
                Torrents & RSS
              </span>
            </button>

            <button
              onClick={() => setActiveTab("discover")}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition ${
                activeTab === "discover"
                  ? "bg-accent text-white shadow-sm"
                  : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Compass className="w-4 h-4" />
                Seasonal & Airing
              </span>
            </button>

            <button
              onClick={() => setActiveTab("recognition")}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition ${
                activeTab === "recognition"
                  ? "bg-accent text-white shadow-sm"
                  : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Activity className="w-4 h-4" />
                Episode Detection
              </span>
              {activeSession && (
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
              )}
            </button>

            <button
              onClick={() => setActiveTab("settings")}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition ${
                activeTab === "settings"
                  ? "bg-accent text-white shadow-sm"
                  : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Settings className="w-4 h-4" />
                Themes & Plugins
              </span>
            </button>
          </nav>
        </div>

        {/* Bottom Stats & Tracker Status Footer */}
        <div className="p-4 border-t border-border-subtle space-y-3 text-xs">
          <div className="grid grid-cols-2 gap-2">
            <div className="p-2.5 rounded-xl bg-bg-primary border border-border-subtle">
              <div className="text-[10px] text-text-muted uppercase">
                Episodes Seen
              </div>
              <div className="font-mono font-bold text-sm text-accent mt-0.5">
                {totalEpisodesWatched}
              </div>
            </div>
            <div className="p-2.5 rounded-xl bg-bg-primary border border-border-subtle">
              <div className="text-[10px] text-text-muted uppercase">
                On Disk
              </div>
              <div className="font-mono font-bold text-sm text-emerald-400 mt-0.5">
                {totalLocalFilesMatched} eps
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between text-[11px] text-text-muted px-1">
            <span className="flex items-center gap-1.5 truncate">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              Plugin:{" "}
              <strong className="text-text-primary uppercase">
                {settings?.active_tracker_plugin || "AniList"}
              </strong>
            </span>
            {settings?.anilist_username && (
              <span className="font-mono text-accent truncate max-w-[90px]">
                @{settings.anilist_username}
              </span>
            )}
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        {/* Live "Now Playing" Anisthesia + Anitomy Scrobble Bar */}
        {activeSession && (
          <div className="bg-gradient-to-r from-accent/20 via-bg-secondary to-bg-secondary border-b border-accent/40 px-6 py-2.5 flex items-center justify-between gap-4 shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accent text-white text-[11px] font-bold shrink-0">
                <Play className="w-3 h-3 fill-current" />
                NOW PLAYING ({activeSession.player_name})
              </span>
              <span className="text-xs font-bold text-text-primary truncate">
                {activeSession.matched_anime_title ||
                  activeSession.parsed.anime_title}{" "}
                — Episode {activeSession.parsed.episode_number ?? "?"}
              </span>
              {activeSession.parsed.video_resolution && (
                <span className="px-1.5 py-0.5 rounded bg-bg-tertiary text-emerald-400 font-mono text-[10px]">
                  {activeSession.parsed.video_resolution}
                </span>
              )}
            </div>

            <div className="flex items-center gap-3 shrink-0 text-xs">
              {activeSession.auto_synced ? (
                <span className="text-emerald-400 font-semibold flex items-center gap-1">
                  <CheckCircle2 className="w-4 h-4" />
                  Progress Scrobbled!
                </span>
              ) : (
                <span className="text-amber-300 font-mono text-[11px]">
                  Auto-updating in{" "}
                  {Math.max(
                    0,
                    (settings?.recognition_delay_seconds || 10) -
                      activeSession.elapsed_seconds
                  )}
                  s...
                </span>
              )}
              <button
                onClick={() => handleSimulatePlayback(null, null)}
                className="px-2 py-1 rounded bg-bg-tertiary hover:bg-bg-elevated text-text-secondary text-[11px]"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Active View Content */}
        <main className="flex-1 overflow-y-auto">
          {activeTab === "watchlist" && (
            <div className="p-6 space-y-5 max-w-7xl mx-auto">
              {/* Top Watchlist Filter & View Mode Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-4">
                {/* Status Tabs */}
                <div className="flex flex-wrap items-center gap-1 bg-bg-secondary p-1 rounded-xl border border-border-subtle">
                  {STATUS_TABS.map((tab) => {
                    const active = statusFilter === tab.id;
                    const count = statusCounts[tab.id] || 0;
                    return (
                      <button
                        key={tab.id}
                        onClick={() => setStatusFilter(tab.id)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 ${
                          active
                            ? "bg-accent text-white shadow-sm"
                            : "text-text-secondary hover:text-text-primary"
                        }`}
                      >
                        <span>{tab.label}</span>
                        <span
                          className={`text-[10px] font-mono px-1.5 py-0.2 rounded-full ${
                            active
                              ? "bg-black/25 text-white"
                              : "bg-bg-tertiary text-text-muted"
                          }`}
                        >
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Search, Sort, Random & View Switcher */}
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-text-muted absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Filter title, studio, genre..."
                      className="pl-8 pr-3 py-1.5 rounded-xl bg-bg-secondary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent w-48"
                    />
                  </div>

                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as any)}
                    className="px-2.5 py-1.5 rounded-xl bg-bg-secondary border border-border-subtle text-xs text-text-primary"
                  >
                    <option value="updated">Sort: Last Updated</option>
                    <option value="title">Sort: Title (A-Z)</option>
                    <option value="score">Sort: My Score</option>
                    <option value="progress">Sort: Progress</option>
                  </select>

                  <button
                    onClick={() => {
                      if (filteredAnime.length > 0) {
                        const rand =
                          filteredAnime[
                            Math.floor(Math.random() * filteredAnime.length)
                          ];
                        setSelectedAnime(rand);
                      }
                    }}
                    className="p-2 rounded-xl bg-bg-secondary hover:bg-bg-tertiary border border-border-subtle text-text-secondary hover:text-text-primary transition"
                    title="Pick Random Anime from Current List"
                  >
                    <Shuffle className="w-3.5 h-3.5" />
                  </button>

                  {settings && (
                    <div className="flex items-center bg-bg-secondary p-1 rounded-xl border border-border-subtle">
                      <button
                        onClick={() =>
                          handleUpdateSettings({
                            ...settings,
                            view_mode: "grid",
                          })
                        }
                        className={`p-1.5 rounded-lg transition ${
                          viewMode === "grid"
                            ? "bg-accent text-white"
                            : "text-text-muted hover:text-text-primary"
                        }`}
                        title="Poster Grid View"
                      >
                        <LayoutGrid className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() =>
                          handleUpdateSettings({
                            ...settings,
                            view_mode: "compact",
                          })
                        }
                        className={`p-1.5 rounded-lg transition ${
                          viewMode === "compact"
                            ? "bg-accent text-white"
                            : "text-text-muted hover:text-text-primary"
                        }`}
                        title="Detailed Cards View"
                      >
                        <Rows className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() =>
                          handleUpdateSettings({
                            ...settings,
                            view_mode: "table",
                          })
                        }
                        className={`p-1.5 rounded-lg transition ${
                          viewMode === "table"
                            ? "bg-accent text-white"
                            : "text-text-muted hover:text-text-primary"
                        }`}
                        title="Taiga Classic Dense Table View"
                      >
                        <List className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Watchlist Rendering */}
              {filteredAnime.length === 0 ? (
                <div className="py-16 text-center bg-bg-secondary border border-border-subtle rounded-2xl space-y-3">
                  <p className="text-sm font-semibold text-text-primary">
                    No anime in this list view
                  </p>
                  <p className="text-xs text-text-muted">
                    Use the Discover tab to add shows or sync your AniList account in Settings.
                  </p>
                </div>
              ) : viewMode === "grid" ? (
                /* Poster Grid View */
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                  {filteredAnime.map((anime) => {
                    const pct = anime.episodes
                      ? Math.min(
                          100,
                          Math.round((anime.user_progress / anime.episodes) * 100)
                        )
                      : 50;
                    const cd = formatCountdown(anime.next_airing_at);

                    return (
                      <div
                        key={anime.id}
                        onClick={() => setSelectedAnime(anime)}
                        className="group relative bg-bg-secondary border border-border-subtle hover:border-accent/70 rounded-2xl overflow-visible flex flex-col cursor-pointer transition shadow-sm hover:shadow-xl"
                      >
                        <div className="relative aspect-[3/4] w-full rounded-t-2xl overflow-hidden bg-bg-tertiary">
                          <img
                            src={anime.cover_image}
                            alt={anime.title_romaji}
                            loading="lazy"
                            decoding="async"
                            className="w-full h-full object-cover group-hover:scale-105 transition duration-300"
                          />
                          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/15 to-transparent" />

                          {/* Top Left Badges: Disk Episodes & Airing Countdown */}
                          <div className="absolute top-2.5 left-2.5 flex flex-col gap-1">
                            {anime.local_episode_count > 0 && (
                              <span className="px-2 py-0.5 rounded-md bg-emerald-500/90 text-black text-[10px] font-bold flex items-center gap-1 shadow">
                                <HardDrive className="w-3 h-3" />
                                {anime.local_episode_count} on disk
                              </span>
                            )}
                            {cd && anime.next_airing_episode && (
                              <span className="px-2 py-0.5 rounded-md bg-black/80 backdrop-blur-sm text-emerald-400 text-[10px] font-mono font-semibold flex items-center gap-1">
                                <Clock className="w-2.5 h-2.5" />
                                Ep {anime.next_airing_episode} in {cd}
                              </span>
                            )}
                          </div>

                          {/* Top Right Quick Menu Trigger (Small Menu per Anime) */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setQuickMenuAnimeId(
                                quickMenuAnimeId === anime.id ? null : anime.id
                              );
                            }}
                            className="absolute top-2.5 right-2.5 p-1.5 rounded-lg bg-black/75 hover:bg-accent text-white transition"
                            title="Quick Info Menu"
                          >
                            <MoreHorizontal className="w-4 h-4" />
                          </button>

                          {/* Bottom Overlay: Score & Progress +1 */}
                          <div className="absolute bottom-2.5 left-3 right-3 flex items-center justify-between text-white">
                            <span className="text-xs font-mono font-bold">
                              Ep {anime.user_progress} / {anime.episodes ?? "?"}
                            </span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleStepEpisode(anime, 1);
                              }}
                              className="px-2 py-1 rounded-lg bg-accent hover:bg-accent-hover text-white text-[11px] font-bold flex items-center gap-0.5 shadow"
                              title="Increment Episode (+1)"
                            >
                              <Plus className="w-3 h-3" />1
                            </button>
                          </div>
                        </div>

                        {/* Progress Bar */}
                        <div className="w-full h-1 bg-bg-tertiary overflow-hidden">
                          <div
                            className="h-full bg-accent transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>

                        {/* Card Footer */}
                        <div className="p-3 flex-1 flex flex-col justify-between">
                          <h3
                            className="text-xs font-bold text-text-primary line-clamp-1 group-hover:text-accent transition"
                            title={anime.title_romaji}
                          >
                            {anime.title_romaji}
                          </h3>
                          <div className="flex items-center justify-between text-[11px] text-text-muted mt-1">
                            <span className="truncate">
                              {anime.studios[0] || anime.format}
                            </span>
                            {anime.user_score > 0 && (
                              <span className="flex items-center gap-0.5 text-amber-400 font-mono font-semibold shrink-0">
                                <Star className="w-3 h-3 fill-amber-400" />
                                {anime.user_score}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Floating Small Quick Info Menu */}
                        {quickMenuAnimeId === anime.id && (
                          <div className="absolute top-11 right-2 z-40">
                            <AnimeQuickMenu
                              anime={anime}
                              onClose={() => setQuickMenuAnimeId(null)}
                              onOpenFullModal={(a) => setSelectedAnime(a)}
                              onStepEpisode={handleStepEpisode}
                              onSearchTorrents={(q) => {
                                setTorrentSearchQuery(q);
                                setActiveTab("torrents");
                              }}
                              onSimulatePlayback={(fname) =>
                                handleSimulatePlayback("mpv", fname)
                              }
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : viewMode === "compact" ? (
                /* Detailed 2-Column Cards View */
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {filteredAnime.map((anime) => (
                    <div
                      key={anime.id}
                      onClick={() => setSelectedAnime(anime)}
                      className="flex gap-4 p-3.5 rounded-2xl bg-bg-secondary border border-border-subtle hover:border-accent/60 cursor-pointer transition"
                    >
                      <img
                        src={anime.cover_image}
                        alt={anime.title_romaji}
                        loading="lazy"
                        decoding="async"
                        className="w-20 h-28 object-cover rounded-xl shrink-0"
                      />
                      <div className="flex-1 min-w-0 flex flex-col justify-between">
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <h3 className="text-sm font-bold text-text-primary truncate">
                              {anime.title_romaji}
                            </h3>
                            <span className="px-2 py-0.5 rounded bg-bg-tertiary text-[10px] font-mono text-text-secondary shrink-0">
                              {anime.format}
                            </span>
                          </div>
                          <p className="text-[11px] text-text-muted line-clamp-2 mt-1">
                            {anime.synopsis}
                          </p>
                        </div>

                        <div className="flex items-center justify-between gap-2 pt-2 border-t border-border-subtle text-xs">
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-bold text-accent">
                              Ep {anime.user_progress} / {anime.episodes ?? "?"}
                            </span>
                            {anime.local_episode_count > 0 && (
                              <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 text-[10px] font-mono">
                                {anime.local_episode_count} local
                              </span>
                            )}
                          </div>

                          <div
                            className="flex items-center gap-1"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              onClick={() => handleStepEpisode(anime, -1)}
                              className="p-1.5 rounded-lg bg-bg-primary hover:bg-bg-tertiary border border-border-subtle text-text-secondary"
                            >
                              <Minus className="w-3 h-3" />
                            </button>
                            <button
                              onClick={() => handleStepEpisode(anime, 1)}
                              className="px-2.5 py-1 rounded-lg bg-accent hover:bg-accent-hover text-white font-semibold text-xs flex items-center gap-1"
                            >
                              <Plus className="w-3 h-3" />1
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                /* Taiga Classic Dense Table View */
                <div className="bg-bg-secondary border border-border-subtle rounded-2xl overflow-hidden">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead className="bg-bg-tertiary text-text-muted uppercase text-[10px]">
                      <tr>
                        <th className="py-2.5 px-4">Anime Title</th>
                        <th className="py-2.5 px-3">Type</th>
                        <th className="py-2.5 px-3">Progress</th>
                        <th className="py-2.5 px-3">On Disk</th>
                        <th className="py-2.5 px-3">Score</th>
                        <th className="py-2.5 px-3">Season</th>
                        <th className="py-2.5 px-4 text-right">Quick Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-subtle">
                      {filteredAnime.map((anime) => {
                        const pct = anime.episodes
                          ? Math.min(
                              100,
                              Math.round(
                                (anime.user_progress / anime.episodes) * 100
                              )
                            )
                          : 50;
                        return (
                          <tr
                            key={anime.id}
                            onClick={() => setSelectedAnime(anime)}
                            className="hover:bg-bg-tertiary/60 cursor-pointer transition"
                          >
                            <td className="py-2.5 px-4 flex items-center gap-3">
                              <img
                                src={anime.cover_image}
                                alt={anime.title_romaji}
                                loading="lazy"
                                decoding="async"
                                className="w-7 h-10 object-cover rounded shrink-0"
                              />
                              <div>
                                <div className="font-semibold text-text-primary">
                                  {anime.title_romaji}
                                </div>
                                <div className="text-[10px] text-text-muted">
                                  {anime.studios.join(", ")}
                                </div>
                              </div>
                            </td>
                            <td className="py-2.5 px-3 font-mono text-[11px] text-text-secondary">
                              {anime.format}
                            </td>
                            <td className="py-2.5 px-3 w-44">
                              <div className="flex items-center justify-between text-[11px] font-mono mb-1">
                                <span>
                                  {anime.user_progress} / {anime.episodes ?? "?"}
                                </span>
                                <span className="text-text-muted">{pct}%</span>
                              </div>
                              <div className="w-full h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
                                <div
                                  className="h-full bg-accent rounded-full"
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                            </td>
                            <td className="py-2.5 px-3 font-mono text-[11px]">
                              {anime.local_episode_count > 0 ? (
                                <span className="text-emerald-400 font-semibold">
                                  {anime.local_episode_count} files
                                </span>
                              ) : (
                                <span className="text-text-muted">-</span>
                              )}
                            </td>
                            <td className="py-2.5 px-3 font-mono font-bold text-amber-400">
                              {anime.user_score > 0 ? anime.user_score : "-"}
                            </td>
                            <td className="py-2.5 px-3 text-[11px] text-text-secondary">
                              {anime.season || ""} {anime.season_year || ""}
                            </td>
                            <td
                              className="py-2.5 px-4 text-right"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <div className="flex items-center justify-end gap-1">
                                <button
                                  onClick={() => handleStepEpisode(anime, -1)}
                                  className="p-1.5 rounded bg-bg-primary hover:bg-bg-tertiary border border-border-subtle text-text-secondary"
                                >
                                  <Minus className="w-3 h-3" />
                                </button>
                                <button
                                  onClick={() => handleStepEpisode(anime, 1)}
                                  className="px-2 py-1 rounded bg-accent hover:bg-accent-hover text-white font-mono font-bold text-[11px]"
                                >
                                  +1
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {activeTab === "library" && (
            <LibraryManagerView
              animeList={animeList}
              onRefreshAnimeList={() => refreshAnimeList()}
              onSelectAnime={(a) => setSelectedAnime(a)}
              showToast={showToast}
            />
          )}

          {activeTab === "torrents" && (
            <TorrentsView
              animeList={animeList}
              initialQuery={torrentSearchQuery}
              onSelectAnime={(a) => setSelectedAnime(a)}
              showToast={showToast}
            />
          )}

          {activeTab === "discover" && (
            <DiscoverAndScheduleView
              animeList={animeList}
              onRefreshAnimeList={refreshAnimeList}
              onSelectAnime={(a) => setSelectedAnime(a)}
              showToast={showToast}
            />
          )}

          {activeTab === "recognition" && settings && (
            <RecognitionView
              activeSession={activeSession}
              settings={settings}
              onUpdateSettings={handleUpdateSettings}
              onSimulate={handleSimulatePlayback}
              showToast={showToast}
            />
          )}

          {activeTab === "settings" && settings && (
            <SettingsAndPluginsView
              settings={settings}
              onUpdateSettings={handleUpdateSettings}
              onRefreshAnimeList={refreshAnimeList}
              showToast={showToast}
            />
          )}
        </main>
      </div>

      {/* Rich Anime Detail Slide-over Modal */}
      {selectedAnime && (
        <AnimeDetailModal
          anime={selectedAnime}
          onClose={() => setSelectedAnime(null)}
          onUpdated={(updated) => {
            setAnimeList((prev) =>
              prev.map((a) => (a.id === updated.id ? updated : a))
            );
            setSelectedAnime(updated);
          }}
          onDeleted={(deletedId) => {
            setAnimeList((prev) => prev.filter((a) => a.id !== deletedId));
            setSelectedAnime(null);
            showToast("Removed anime from library", "info");
          }}
          onSearchTorrents={(q) => {
            setSelectedAnime(null);
            setTorrentSearchQuery(q);
            setActiveTab("torrents");
          }}
          onSimulatePlayback={(fname) => {
            handleSimulatePlayback("mpv", fname);
            showToast(`Simulating playback: ${fname}`, "info");
          }}
          showToast={showToast}
        />
      )}

      {/* Ctrl+K Command Palette */}
      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        animeList={animeList}
        onSelectAnime={(a) => setSelectedAnime(a)}
        onIncrementAnime={(a) => handleStepEpisode(a, 1)}
        onNavigateTab={(t) => setActiveTab(t)}
        onScanDrives={async () => {
          const sum = await toraApi.scanLibrary();
          await refreshAnimeList();
          showToast(
            `Scanned ${sum.total_files_indexed} files in ${sum.elapsed_ms}ms`,
            "success"
          );
        }}
        onSwitchTheme={async (themeId, accent) => {
          if (!settings) return;
          applyThemeToDocument(themeId, accent);
          await handleUpdateSettings({
            ...settings,
            theme: themeId,
            accent_color: accent,
          });
        }}
      />

      {/* Toast Notification */}
      {toast && (
        <div
          className={`fixed bottom-5 right-5 z-50 px-4 py-3 rounded-xl shadow-2xl border text-xs font-semibold flex items-center gap-2.5 transition-all ${
            toast.type === "error"
              ? "bg-red-950/95 border-red-500 text-red-200"
              : toast.type === "success"
              ? "bg-emerald-950/95 border-emerald-500 text-emerald-200"
              : "bg-bg-elevated border-accent text-text-primary"
          }`}
        >
          <Sparkles className="w-4 h-4 text-accent shrink-0" />
          <span>{toast.msg}</span>
        </div>
      )}
    </div>
  );
};
