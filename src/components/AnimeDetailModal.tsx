import React, { useEffect, useRef, useState } from "react";
import {
  X,
  Play,
  FolderOpen,
  Search,
  Plus,
  Minus,
  Star,
  Calendar,
  Tv,
  HardDrive,
  ExternalLink,
  Trash2,
  Save,
  Film,
  Tag,
  ListChecks,
} from "lucide-react";
import { AnimeEntry, LocalEpisodeFile } from "../types";
import { formatBytes, formatCountdown, getOptimizedCoverUrl, toraApi } from "../api";
import { open } from "@tauri-apps/plugin-dialog";
import { useCustomLists } from "../customLists";
import { CustomListsPanel } from "./CustomListsPanel";
import { altTitles, useAnimeTitle, useTitleLanguage } from "../titles";
import { TorrentSearchRequest, torrentSearchFor } from "../torrents";

interface AnimeDetailModalProps {
  anime: AnimeEntry;
  /** false for anime opened from Seasons/Search that aren't in the user's list: tracking controls are hidden */
  inList: boolean;
  onAddToList: (status: "CURRENT" | "PLANNING") => Promise<void>;
  onClose: () => void;
  onUpdated: (updated: AnimeEntry) => void;
  /** A debounced ± step saved after the drawer closed or switched anime: update the list only */
  onSavedInBackground?: (updated: AnimeEntry) => void;
  onDeleted: (animeId: number) => void;
  onSearchTorrents: (req: TorrentSearchRequest) => void;
  showToast: (msg: string, type?: "success" | "info" | "error") => void;
}

export const AnimeDetailModal: React.FC<AnimeDetailModalProps> = ({
  anime,
  inList,
  onAddToList,
  onClose,
  onUpdated,
  onSavedInBackground,
  onDeleted,
  onSearchTorrents,
  showToast,
}) => {
  const titleOf = useAnimeTitle();
  const titleLanguage = useTitleLanguage();
  const customListNames = useCustomLists().names;
  const [status, setStatus] = useState(anime.user_status);
  const [progress, setProgress] = useState(anime.user_progress);
  const [score, setScore] = useState(anime.user_score);
  const [repeats, setRepeats] = useState(anime.user_repeats);
  const [notes, setNotes] = useState(anime.user_notes);
  const [startedAt, setStartedAt] = useState(anime.user_started_at || "");
  const [completedAt, setCompletedAt] = useState(anime.user_completed_at || "");
  const [customFolder, setCustomFolder] = useState(anime.custom_folder || "");
  const [synonymsInput, setSynonymsInput] = useState(anime.custom_synonyms.join(", "));
  const [localFiles, setLocalFiles] = useState<LocalEpisodeFile[]>([]);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const stepSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The save a pending ± step will make, so closing the drawer (or switching anime) flushes it
  const pendingStepSaveRef = useRef<Parameters<typeof toraApi.updateAnimeEntry>[0] | null>(null);
  const backgroundRef = useRef({ onSavedInBackground, showToast });
  backgroundRef.current = { onSavedInBackground, showToast };

  useEffect(() => {
    return () => {
      if (stepSaveTimerRef.current) {
        clearTimeout(stepSaveTimerRef.current);
        stepSaveTimerRef.current = null;
      }
      const pending = pendingStepSaveRef.current;
      pendingStepSaveRef.current = null;
      if (!pending) return;
      const { onSavedInBackground, showToast } = backgroundRef.current;
      toraApi
        .updateAnimeEntry(pending)
        .then((updated) => onSavedInBackground?.(updated))
        .catch((e) => showToast(String(e), "error"));
    };
  }, [anime.id]);

  // Sync lightweight user fields when anime prop updates
  useEffect(() => {
    setStatus(anime.user_status);
    setProgress(anime.user_progress);
    setScore(anime.user_score);
    setRepeats(anime.user_repeats);
    setStartedAt(anime.user_started_at || "");
    setCompletedAt(anime.user_completed_at || "");
  }, [
    anime.id,
    anime.user_status,
    anime.user_progress,
    anime.user_score,
    anime.user_repeats,
    anime.user_started_at,
    anime.user_completed_at,
  ]);

  // Reload text inputs when switching to a different anime ID
  useEffect(() => {
    setNotes(anime.user_notes);
    setCustomFolder(anime.custom_folder || "");
    setSynonymsInput(anime.custom_synonyms.join(", "));
  }, [anime.id]);

  // Reload local files when anime ID or matched episode count changes (only list entries have local files)
  useEffect(() => {
    if (inList) {
      loadLocalFiles(anime.id);
    } else {
      setLocalFiles([]);
    }
  }, [anime.id, anime.local_episode_count, inList]);

  const handleAddToList = async (nextStatus: "CURRENT" | "PLANNING") => {
    setAdding(true);
    try {
      await onAddToList(nextStatus);
    } finally {
      setAdding(false);
    }
  };

  const loadLocalFiles = async (animeId: number) => {
    try {
      const files = await toraApi.getLocalEpisodes(animeId);
      setLocalFiles(files);
    } catch (e) {
      console.error("Failed to load local episodes for anime:", e);
    }
  };

  const handleSave = async (
    nextStatus = status,
    nextProgress = progress,
    nextScore = score,
    nextRepeats = repeats,
    includeMetadata = false,
    nextStartedAt = startedAt,
    nextCompletedAt = completedAt
  ) => {
    setSaving(true);
    try {
      const parsedSynonyms = includeMetadata
        ? synonymsInput
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
        : null;

      const updated = await toraApi.updateAnimeEntry({
        animeId: anime.id,
        userStatus: nextStatus,
        userProgress: nextProgress,
        userScore: nextScore,
        userRepeats: nextRepeats,
        userNotes: notes,
        customFolder: customFolder.trim() || null,
        synonyms: parsedSynonyms,
        userStartedAt: nextStartedAt.trim(),
        userCompletedAt: nextCompletedAt.trim(),
      });
      onUpdated(updated);
      if (includeMetadata) {
        await loadLocalFiles(anime.id);
      } else {
        setLocalFiles((prev) =>
          prev.map((f) => ({
            ...f,
            watched:
              f.episode_number !== null && f.episode_number <= nextProgress,
          }))
        );
      }
      showToast(`Saved changes for ${titleOf(anime)}`, "success");
    } catch (e: any) {
      showToast(String(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const handleQuickEpisodeStep = (delta: number) => {
    const maxEp = anime.episodes || 9999;
    const nextProg = Math.max(0, Math.min(maxEp, progress + delta));
    let nextStat = status;
    if (anime.episodes && nextProg >= anime.episodes) {
      nextStat = "COMPLETED";
    } else if (nextProg > 0 && status === "PLANNING") {
      nextStat = "CURRENT";
    }
    // Instant optimistic UI update in modal
    setProgress(nextProg);
    setStatus(nextStat);
    setLocalFiles((prev) =>
      prev.map((f) => ({
        ...f,
        watched:
          f.episode_number !== null && f.episode_number <= nextProg,
      }))
    );

    if (stepSaveTimerRef.current) {
      clearTimeout(stepSaveTimerRef.current);
    }
    pendingStepSaveRef.current = {
      animeId: anime.id,
      userStatus: nextStat,
      userProgress: nextProg,
      userScore: score,
      userRepeats: repeats,
      userNotes: notes,
      customFolder: customFolder.trim() || null,
      synonyms: null,
      userStartedAt: startedAt.trim(),
      userCompletedAt: completedAt.trim(),
    };
    stepSaveTimerRef.current = setTimeout(() => {
      stepSaveTimerRef.current = null;
      pendingStepSaveRef.current = null;
      handleSave(nextStat, nextProg, score, repeats, false);
    }, 1200);
  };

  const handlePlayEpisodeNumber = async (epNum: number) => {
    const file = localFiles.find((f) => f.episode_number === epNum);
    if (file) {
      try {
        await toraApi.playEpisodeFile(file.file_path);
        showToast(`Playing Episode ${epNum}: ${file.file_name}`, "info");
      } catch (e: any) {
        showToast(String(e), "error");
      }
    } else {
      onSearchTorrents(torrentSearchFor(anime));
    }
  };

  const handlePlayNextUnwatched = async () => {
    const nextEp = progress + 1;
    const file = localFiles.find((f) => f.episode_number === nextEp);
    if (file) {
      await toraApi.playEpisodeFile(file.file_path);
      showToast(`Playing next episode (#${nextEp})`, "info");
    } else {
      showToast(`No local file for episode ${nextEp}`, "info");
    }
  };

  const handleOpenAniList = async () => {
    try {
      await toraApi.openExternalUrl(anime.site_url || `https://anilist.co/anime/${anime.id}`);
    } catch (e: any) {
      showToast(String(e), "error");
    }
  };

  const handleBrowseFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Anime Folder",
        defaultPath: anime.custom_folder || undefined
      });
      if (selected && typeof selected === "string") {
        setCustomFolder(selected);
      }
    } catch {
      // Fallback if dialog cancelled
    }
  };

  const hasFolder = Boolean(
    customFolder.trim() ||
    anime.custom_folder?.trim() ||
    localFiles.length > 0 ||
    anime.local_episode_count > 0
  );

  const handleOpenFolder = async () => {
    try {
      const target = customFolder.trim() || anime.custom_folder?.trim();
      if (target) {
        await toraApi.revealInExplorer(target);
        return;
      }
      if (localFiles.length > 0 && localFiles[0].file_path) {
        await toraApi.revealInExplorer(localFiles[0].file_path);
        return;
      }
      if (anime.local_episode_count > 0) {
        const files = await toraApi.getLocalEpisodes(anime.id);
        if (files.length > 0) {
          await toraApi.revealInExplorer(files[0].file_path);
          return;
        }
      }
      showToast(`No local folder linked for "${titleOf(anime)}"`, "error");
    } catch (e: any) {
      showToast(String(e), "error");
    }
  };

  const totalGridCount = Math.min(
    Math.max(anime.episodes || 12, progress, ...anime.available_episodes, 12),
    100
  );
  const countdown = formatCountdown(anime.next_airing_at);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-end bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-3xl h-full bg-bg-secondary border-l border-border-subtle flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Hero Banner */}
        <div className="relative h-48 w-full bg-bg-tertiary shrink-0 overflow-hidden">
          {anime.banner_image || anime.cover_image ? (
            <img
              src={anime.banner_image || getOptimizedCoverUrl(anime.cover_image, "large")}
              alt={titleOf(anime)}
              decoding="async"
              className="w-full h-full object-cover opacity-45 scale-105 blur-[1px]"
            />
          ) : null}
          <div className="absolute inset-0 bg-gradient-to-t from-bg-secondary via-bg-secondary/60 to-transparent" />

          <button
            type="button"
            onClick={onClose}
            className="
              z-30 absolute top-3.5 right-3.5 w-10 h-10
              flex items-center justify-center rounded-xl
              bg-black/65 hover:bg-accent text-white
              border border-white/15 shadow-lg transition cursor-pointer
            "
            title="Close (Esc)"
          >
            <X className="w-5 h-5" />
          </button>

          {/* Cover & Title Header */}
          <div className="absolute bottom-3 left-6 right-16 flex items-end gap-5 pointer-events-none">
            <img
              src={getOptimizedCoverUrl(anime.cover_image, "medium")}
              alt={titleOf(anime)}
              decoding="async"
              className="w-24 h-36 object-cover rounded-xl shadow-xl border-2 border-border-subtle shrink-0 bg-bg-tertiary"
            />
            <div className="flex-1 min-w-0 pb-1">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <span className="px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider rounded bg-accent text-white">
                  {anime.format}
                </span>
                <span className="px-2 py-0.5 text-[11px] font-medium rounded bg-bg-elevated text-text-secondary border border-border-subtle">
                  {anime.airing_status.replace(/_/g, " ")}
                </span>
                {anime.average_score && (
                  <span className="flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold rounded bg-amber-500/20 text-amber-400">
                    <Star className="w-3 h-3 fill-amber-400" />
                    {anime.average_score}%
                  </span>
                )}
                {countdown && anime.next_airing_episode && (
                  <span className="px-2 py-0.5 text-[11px] font-medium rounded bg-emerald-500/20 text-emerald-400">
                    Ep {anime.next_airing_episode} in {countdown}
                  </span>
                )}
              </div>
              <h2 className="text-xl font-bold text-text-primary truncate">
                {titleOf(anime)}
              </h2>
              {altTitles(anime, titleLanguage).length > 0 && (
                <p className="text-xs text-text-secondary truncate">
                  {altTitles(anime, titleLanguage).join(" • ")}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Quick Action Bar */}
          <div className="flex flex-wrap items-center gap-2.5 bg-bg-tertiary/70 p-3 rounded-xl border border-border-subtle">
            {inList ? (
              <>
                <button
                  onClick={handlePlayNextUnwatched}
                  className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white text-xs font-semibold transition shadow-sm"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  Play Next (Ep {progress + 1})
                </button>

                <button
                  onClick={() => onSearchTorrents(torrentSearchFor(anime))}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-bg-elevated hover:bg-bg-primary text-text-primary text-xs font-medium border border-border-subtle transition"
                >
                  <Search className="w-3.5 h-3.5 text-accent" />
                  Find Torrents
                </button>
              </>
            ) : (
              <span className="text-xs text-text-muted">
                {anime.episodes ? `${anime.episodes} episodes` : "Episode count unknown"}
                {anime.studios.length > 0 ? ` • ${anime.studios.join(", ")}` : ""}
              </span>
            )}

            {anime.site_url && (
              <a
                onClick={handleOpenAniList}
                className="ml-auto flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs text-text-secondary hover:text-accent transition"
              >
                AniList
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>

          {!inList && (
            <div className="flex flex-wrap items-center justify-between gap-3 bg-bg-tertiary/40 p-4 rounded-xl border border-border-subtle">
              <div>
                <div className="text-xs font-semibold text-text-primary">
                  Not in your list
                </div>
                <div className="text-[11px] text-text-muted mt-0.5">
                  Add it to track progress, score and dates.
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleAddToList("PLANNING")}
                  disabled={adding}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-bg-elevated hover:bg-bg-primary text-text-primary text-xs font-medium border border-border-subtle transition disabled:opacity-60"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add to Planning
                </button>
                <button
                  onClick={() => handleAddToList("CURRENT")}
                  disabled={adding}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white text-xs font-semibold transition shadow-sm disabled:opacity-60"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  Add to Watching
                </button>
              </div>
            </div>
          )}

          {inList && (
            <>
              {/* Tracker & Watchlist Controls */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 bg-bg-tertiary/40 p-4 rounded-xl border border-border-subtle">
                <div>
                  <label className="block text-[11px] font-medium text-text-muted uppercase mb-1">
                    Watch Status
                  </label>
                  <select
                    value={status}
                    onChange={(e) => {
                      const nextSt = e.target.value;
                      setStatus(nextSt);
                      handleSave(nextSt, progress, score, repeats, false);
                    }}
                    className="w-full px-2.5 py-2 rounded-lg bg-bg-primary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent"
                  >
                    <option value="CURRENT">Watching</option>
                    <option value="PLANNING">Plan to Watch</option>
                    <option value="COMPLETED">Completed</option>
                    <option value="PAUSED">Paused / On Hold</option>
                    <option value="DROPPED">Dropped</option>
                    <option value="REPEATING">Rewatching</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-text-muted uppercase mb-1">
                    Episode Progress
                  </label>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleQuickEpisodeStep(-1)}
                      className="p-2 rounded-lg bg-bg-primary border border-border-subtle hover:border-accent text-text-secondary hover:text-text-primary"
                    >
                      <Minus className="w-3.5 h-3.5" />
                    </button>
                    <div className="flex-1 text-center font-mono text-xs font-semibold bg-bg-primary py-2 rounded-lg border border-border-subtle">
                      {progress} / {anime.episodes ?? "?"}
                    </div>
                    <button
                      onClick={() => handleQuickEpisodeStep(1)}
                      className="p-2 rounded-lg bg-bg-primary border border-border-subtle hover:border-accent text-text-secondary hover:text-text-primary"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-text-muted uppercase mb-1">
                    Your Score ({score}/100)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={score}
                    onChange={(e) => setScore(Number(e.target.value))}
                    onBlur={() => handleSave(status, progress, score, repeats, false)}
                    className="w-full px-3 py-2 rounded-lg bg-bg-primary border border-border-subtle text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-text-muted uppercase mb-1">
                    Rewatch Count
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={99}
                    value={repeats}
                    onChange={(e) => setRepeats(Number(e.target.value))}
                    onBlur={() => handleSave(status, progress, score, repeats, false)}
                    className="w-full px-3 py-2 rounded-lg bg-bg-primary border border-border-subtle text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
                  />
                </div>

                <div className="md:col-span-2">
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-[11px] font-medium text-text-muted uppercase">
                      Date Started
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        const today = new Date().toISOString().slice(0, 10);
                        setStartedAt(today);
                        handleSave(status, progress, score, repeats, false, today, completedAt);
                      }}
                      className="text-[10px] font-semibold text-accent hover:underline"
                    >
                      Set Today
                    </button>
                  </div>
                  <input
                    type="date"
                    value={startedAt}
                    onChange={(e) => {
                      const nextDate = e.target.value;
                      setStartedAt(nextDate);
                      handleSave(status, progress, score, repeats, false, nextDate, completedAt);
                    }}
                    className="w-full px-3 py-2 rounded-lg bg-bg-primary border border-border-subtle text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
                  />
                </div>

                <div className="md:col-span-2">
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-[11px] font-medium text-text-muted uppercase">
                      Date Completed
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        const today = new Date().toISOString().slice(0, 10);
                        setCompletedAt(today);
                        handleSave(status, progress, score, repeats, false, startedAt, today);
                      }}
                      className="text-[10px] font-semibold text-accent hover:underline"
                    >
                      Set Today
                    </button>
                  </div>
                  <input
                    type="date"
                    value={completedAt}
                    onChange={(e) => {
                      const nextDate = e.target.value;
                      setCompletedAt(nextDate);
                      handleSave(status, progress, score, repeats, false, startedAt, nextDate);
                    }}
                    className="w-full px-3 py-2 rounded-lg bg-bg-primary border border-border-subtle text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
                  />
                </div>
              </div>

              {/* AniList custom lists (hidden when the user has none) */}
              {customListNames.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary flex items-center gap-2">
                    <ListChecks className="w-4 h-4 text-accent" />
                    Custom Lists
                  </h3>
                  <CustomListsPanel animeIds={[anime.id]} variant="chips" showToast={showToast} />
                </div>
              )}

              {/* Interactive Episode Availability Grid */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary flex items-center gap-2">
                    <Film className="w-4 h-4 text-accent" />
                    Episode Grid & Local Disk Availability ({localFiles.length} files on disk)
                  </h3>
                  <div className="flex items-center gap-3 text-[11px] text-text-muted">
                    <span className="flex items-center gap-1">
                      <span className="w-2.5 h-2.5 rounded-sm bg-amber-500 inline-block" />
                      Unwatched on Disk
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500/80 inline-block" />
                      Watched on Disk
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-2.5 h-2.5 rounded-sm bg-accent/30 inline-block" />
                      Watched
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-8 sm:grid-cols-12 gap-1.5 p-3 rounded-xl bg-bg-primary/60 border border-border-subtle">
                  {Array.from({ length: totalGridCount }, (_, idx) => idx + 1).map(
                    (epNum) => {
                      const hasLocal =
                        anime.available_episodes.includes(epNum) ||
                        localFiles.some((f) => f.episode_number === epNum);
                      const isWatched = epNum <= progress;
                      let btnClass =
                        "bg-bg-tertiary text-text-muted border-border-subtle hover:border-text-secondary";
                      if (hasLocal && !isWatched) {
                        btnClass =
                          "bg-amber-500/20 text-amber-300 border-amber-500/60 font-bold hover:bg-amber-500 hover:text-black shadow-sm";
                      } else if (hasLocal && isWatched) {
                        btnClass =
                          "bg-emerald-500/20 text-emerald-300 border-emerald-500/50 hover:bg-emerald-500 hover:text-black";
                      } else if (isWatched) {
                        btnClass =
                          "bg-accent/15 text-accent border-accent/30 hover:bg-accent/30";
                      }

                      return (
                        <button
                          key={epNum}
                          onClick={() => handlePlayEpisodeNumber(epNum)}
                          title={
                            hasLocal
                              ? `Episode ${epNum} available on disk — Click to play`
                              : `Episode ${epNum} — Click to search torrents for this anime`
                          }
                          className={`py-1.5 rounded-md text-xs font-mono border transition flex items-center justify-center gap-0.5 ${btnClass}`}
                        >
                          {epNum}
                        </button>
                      );
                    }
                  )}
                </div>
              </div>

              {/* Local Files List across Hard Drives */}
              {localFiles.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-text-secondary flex items-center gap-1.5">
                    <HardDrive className="w-3.5 h-3.5 text-accent" />
                    Matched Local Video Files
                  </h4>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                    {localFiles.map((f) => (
                      <div
                        key={f.id}
                        className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-bg-primary border border-border-subtle hover:border-accent/50 text-xs transition"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="px-1.5 py-0.5 rounded bg-bg-tertiary font-mono text-[10px] text-text-secondary shrink-0">
                            {f.drive_root}
                          </span>
                          <span className="px-1.5 py-0.5 rounded bg-accent/20 text-accent font-mono font-semibold shrink-0">
                            Ep {f.episode_number ?? "?"}
                          </span>
                          {f.release_group && (
                            <span className="px-1.5 py-0.5 rounded bg-bg-elevated text-text-secondary text-[10px] shrink-0">
                              [{f.release_group}]
                            </span>
                          )}
                          {f.resolution && (
                            <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 text-[10px] font-mono shrink-0">
                              {f.resolution}
                            </span>
                          )}
                          <span
                            className="truncate text-text-primary"
                            title={f.file_path}
                          >
                            {f.file_name}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className="text-[10px] font-mono text-text-muted">
                            {formatBytes(f.file_size)}
                          </span>
                          <button
                            onClick={() => toraApi.playEpisodeFile(f.file_path)}
                            className="p-1.5 rounded bg-accent/20 hover:bg-accent text-accent hover:text-white transition"
                            title="Play file"
                          >
                            <Play className="w-3.5 h-3.5 fill-current" />
                          </button>
                          <button
                            onClick={() => toraApi.revealInExplorer(f.file_path)}
                            className="p-1.5 rounded bg-bg-tertiary hover:bg-bg-elevated text-text-secondary hover:text-text-primary transition"
                            title="Reveal in Windows Explorer"
                          >
                            <FolderOpen className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Synopsis & Metadata */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
              Synopsis & Details
            </h3>
            <p className="text-xs text-text-secondary leading-relaxed whitespace-pre-line bg-bg-primary/50 p-3.5 rounded-xl border border-border-subtle">
              {anime.synopsis || "No synopsis available."}
            </p>

            <div className="flex flex-wrap gap-2">
              {anime.studios.map((st) => (
                <span
                  key={st}
                  className="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-accent/15 text-accent border border-accent/30"
                >
                  Studio: {st}
                </span>
              ))}
              {anime.genres.map((g) => (
                <span
                  key={g}
                  className="px-2.5 py-1 rounded-full text-[11px] bg-bg-tertiary text-text-secondary border border-border-subtle"
                >
                  {g}
                </span>
              ))}
              {anime.season && anime.season_year && (
                <span className="px-2.5 py-1 rounded-full text-[11px] bg-bg-tertiary text-text-secondary border border-border-subtle flex items-center gap-1">
                  <Calendar className="w-3 h-3" />
                  {anime.season} {anime.season_year}
                </span>
              )}
              {anime.duration && (
                <span className="px-2.5 py-1 rounded-full text-[11px] bg-bg-tertiary text-text-secondary border border-border-subtle flex items-center gap-1">
                  <Tv className="w-3 h-3" />
                  {anime.duration} mins/ep
                </span>
              )}
            </div>
          </div>

          {/* Notes, Custom Folder & the user's own recognition aliases (AniList synonyms are not shown) */}
          {inList && (
            <div className="space-y-3 bg-bg-tertiary/30 p-4 rounded-xl border border-border-subtle">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary flex items-center gap-1.5">
                <Tag className="w-3.5 h-3.5 text-accent" />
                Settings
              </h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-text-muted mb-1">
                    Custom Aliases (file & player recognition)
                  </label>
                  <input
                    type="text"
                    value={synonymsInput}
                    onChange={(e) => setSynonymsInput(e.target.value)}
                    placeholder="e.g. Frieren, Sousou no Frieren"
                    className="w-full px-3 py-2 rounded-lg bg-bg-primary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent"
                  />
                </div>

                <div>
                  <label className="block text-[11px] text-text-muted mb-1">
                    Anime Folder Path
                  </label>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={customFolder}
                      onChange={(e) => setCustomFolder(e.target.value)}
                      placeholder="e.g. D:\Anime\Sousou no Frieren"
                      className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-bg-primary border border-border-subtle text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
                    />
                    <button
                      type="button"
                      onClick={handleOpenFolder}
                      disabled={!hasFolder}
                      title={hasFolder ? "Open folder in Explorer" : "No folder available"}
                      className="self-stretch px-2.5 flex items-center justify-center rounded-lg bg-bg-tertiary hover:bg-bg-elevated border border-border-subtle hover:border-accent text-text-secondary hover:text-text-primary transition shrink-0 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-border-subtle disabled:hover:bg-bg-tertiary disabled:hover:text-text-secondary"
                    >
                      <FolderOpen className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-text-muted mb-1">
                  Personal Notes (synced with AniList)
                </label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Add personal thoughts, release group preferences, etc."
                  className="w-full px-3 py-2 rounded-lg bg-bg-primary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent"
                />
              </div>

              <div className="flex items-center justify-between pt-1">
                <button
                  onClick={async () => {
                    await toraApi.deleteAnimeEntry(anime.id);
                    onDeleted(anime.id);
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-red-400 hover:bg-red-500/15 transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Remove from Library
                </button>

                <button
                  onClick={() => handleSave(status, progress, score, repeats, true)}
                  disabled={saving}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white text-xs font-semibold transition"
                >
                  <Save className="w-3.5 h-3.5" />
                  {saving ? "Saving..." : "Save Details"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
