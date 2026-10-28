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
} from "lucide-react";
import { AnimeEntry, LocalEpisodeFile } from "../types";
import { formatBytes, formatCountdown, getOptimizedCoverUrl, toraApi } from "../api";

interface AnimeDetailModalProps {
  anime: AnimeEntry;
  onClose: () => void;
  onUpdated: (updated: AnimeEntry) => void;
  onDeleted: (animeId: number) => void;
  onSearchTorrents: (query: string) => void;
  showToast: (msg: string, type?: "success" | "info" | "error") => void;
}

export const AnimeDetailModal: React.FC<AnimeDetailModalProps> = ({
  anime,
  onClose,
  onUpdated,
  onDeleted,
  onSearchTorrents,
  showToast,
}) => {
  const [status, setStatus] = useState(anime.user_status);
  const [progress, setProgress] = useState(anime.user_progress);
  const [score, setScore] = useState(anime.user_score);
  const [repeats, setRepeats] = useState(anime.user_repeats);
  const [notes, setNotes] = useState(anime.user_notes);
  const [startedAt, setStartedAt] = useState(anime.user_started_at || "");
  const [completedAt, setCompletedAt] = useState(anime.user_completed_at || "");
  const [customFolder, setCustomFolder] = useState(anime.custom_folder || "");
  const [synonymsInput, setSynonymsInput] = useState(anime.synonyms.join(", "));
  const [localFiles, setLocalFiles] = useState<LocalEpisodeFile[]>([]);
  const [saving, setSaving] = useState(false);
  const stepSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (stepSaveTimerRef.current) {
        clearTimeout(stepSaveTimerRef.current);
      }
    };
  }, []);

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
    setSynonymsInput(anime.synonyms.join(", "));
  }, [anime.id]);

  // Reload local files when anime ID or matched episode count changes
  useEffect(() => {
    loadLocalFiles(anime.id);
  }, [anime.id, anime.local_episode_count]);

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
      showToast(`Saved changes for ${anime.title_romaji}`, "success");
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
    stepSaveTimerRef.current = setTimeout(() => {
      stepSaveTimerRef.current = null;
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
      const nextQuery = `${anime.title_romaji} ${String(epNum).padStart(2, "0")}`;
      onSearchTorrents(nextQuery);
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
              alt={anime.title_romaji}
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
              alt={anime.title_romaji}
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
                {anime.title_romaji}
              </h2>
              {anime.title_english &&
                anime.title_english !== anime.title_romaji && (
                  <p className="text-xs text-text-secondary truncate">
                    {anime.title_english}
                    {anime.title_native ? ` • ${anime.title_native}` : ""}
                  </p>
                )}
            </div>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Quick Action Bar */}
          <div className="flex flex-wrap items-center gap-2.5 bg-bg-tertiary/70 p-3 rounded-xl border border-border-subtle">
            <button
              onClick={handlePlayNextUnwatched}
              className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white text-xs font-semibold transition shadow-sm"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              Play Next (Ep {progress + 1})
            </button>

            <button
              onClick={() =>
                onSearchTorrents(
                  `${anime.title_romaji} ${String(progress + 1).padStart(2, "0")}`
                )
              }
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-bg-elevated hover:bg-bg-primary text-text-primary text-xs font-medium border border-border-subtle transition"
            >
              <Search className="w-3.5 h-3.5 text-accent" />
              Find Ep {progress + 1} Torrent
            </button>

            {anime.site_url && (
              <a
                href={anime.site_url}
                target="_blank"
                rel="noreferrer"
                className="ml-auto flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs text-text-secondary hover:text-accent transition"
              >
                AniList
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>

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
                          : `Episode ${epNum} — Click to search torrent`
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

          {/* Notes, Custom Folder & Recognition Aliases */}
          <div className="space-y-3 bg-bg-tertiary/30 p-4 rounded-xl border border-border-subtle">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary flex items-center gap-1.5">
              <Tag className="w-3.5 h-3.5 text-accent" />
              Recognition Aliases, Custom Folder & Notes
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-text-muted mb-1">
                  Title Aliases / Synonyms (comma-separated for Anitomy matching)
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
                  Dedicated Anime Folder Path (for Library & qBittorrent)
                </label>
                <input
                  type="text"
                  value={customFolder}
                  onChange={(e) => setCustomFolder(e.target.value)}
                  placeholder="e.g. D:\Anime\Sousou no Frieren"
                  className="w-full px-3 py-2 rounded-lg bg-bg-primary border border-border-subtle text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
                />
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
        </div>
      </div>
    </div>
  );
};
