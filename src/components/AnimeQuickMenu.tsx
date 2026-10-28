import React, { useState } from "react";
import {
  Play,
  History,
  FolderOpen,
  Plus,
  Minus,
  Search,
  Copy,
  Pencil,
  Trash2,
  CheckCircle2,
  Calendar,
  StickyNote,
  Star,
  Layers,
  ChevronRight,
  ChevronDown,
  X,
  Check,
  Tv,
  Clock,
  PauseCircle,
  XCircle,
  RotateCcw,
} from "lucide-react";
import { AnimeEntry, BatchAnimeUpdatePatch } from "../types";
import { getOptimizedCoverUrl, toraApi } from "../api";

interface AnimeQuickMenuProps {
  anime: AnimeEntry;
  selectedAnime?: AnimeEntry[];
  onClose: () => void;
  onOpenFullModal: (anime: AnimeEntry) => void;
  onStepEpisode: (anime: AnimeEntry, delta: number) => void;
  onBatchUpdate: (patch: BatchAnimeUpdatePatch, summaryToast: string) => Promise<void>;
  onBatchDelete: (animeList: AnimeEntry[]) => Promise<void>;
  onClearSelection?: () => void;
  onSearchTorrents: (query: string) => void;
  onDeleteAnime: (anime: AnimeEntry) => void;
  showToast: (msg: string, type?: "success" | "info" | "error") => void;
}

export const STATUS_OPTIONS = [
  { id: "CURRENT", label: "Watching", icon: Tv, color: "text-accent" },
  { id: "PLANNING", label: "Plan to Watch", icon: Clock, color: "text-sky-400" },
  { id: "COMPLETED", label: "Completed", icon: CheckCircle2, color: "text-emerald-400" },
  { id: "PAUSED", label: "Paused", icon: PauseCircle, color: "text-amber-400" },
  { id: "DROPPED", label: "Dropped", icon: XCircle, color: "text-rose-400" },
  { id: "REPEATING", label: "Rewatching", icon: RotateCcw, color: "text-violet-400" },
];

type ActiveInlinePanel =
  | null
  | "status"
  | "notes"
  | "date_started"
  | "date_completed"
  | "score"
  | "progress";

export const AnimeQuickMenu: React.FC<AnimeQuickMenuProps> = ({
  anime,
  selectedAnime = [],
  onClose,
  onOpenFullModal,
  onStepEpisode,
  onBatchUpdate,
  onBatchDelete,
  onClearSelection,
  onSearchTorrents,
  onDeleteAnime,
  showToast,
}) => {
  const isMultiSelect = selectedAnime.length > 1;
  const targets = isMultiSelect ? selectedAnime : [anime];
  const targetIds = targets.map((a) => a.id);

  const todayIso = new Date().toISOString().slice(0, 10);

  // Shared inline editor state for both single and multi-select menus
  const [activePanel, setActivePanel] = useState<ActiveInlinePanel>(null);
  const [notesValue, setNotesValue] = useState<string>(
    !isMultiSelect ? anime.user_notes || "" : ""
  );
  const [notesMode, setNotesMode] = useState<"replace" | "append">("replace");
  const [dateStartedValue, setDateStartedValue] = useState<string>(
    (!isMultiSelect && anime.user_started_at) || todayIso
  );
  const [dateCompletedValue, setDateCompletedValue] = useState<string>(
    (!isMultiSelect && anime.user_completed_at) || todayIso
  );
  const [scoreValue, setScoreValue] = useState<number>(
    !isMultiSelect && anime.user_score > 0 ? anime.user_score : 85
  );
  const [progressValue, setProgressValue] = useState<number>(
    !isMultiSelect ? anime.user_progress : 0
  );

  const togglePanel = (panel: ActiveInlinePanel) => {
    setActivePanel((prev) => (prev === panel ? null : panel));
  };

  const itemClass =
    "w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left text-xs text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/90 disabled:opacity-40 disabled:pointer-events-none transition cursor-pointer";

  // ============================================================================
  // MULTI-SELECT CONTEXT MENU (2+ anime selected)
  // ============================================================================
  if (isMultiSelect) {
    const totalOnDisk = targets.reduce((acc, a) => acc + a.local_episode_count, 0);

    const handleMoveStatus = async (statusId: string, label: string, markMaxProgress = false) => {
      onClose();
      await onBatchUpdate(
        {
          anime_ids: targetIds,
          user_status: statusId,
          mark_completed_progress: markMaxProgress ? true : null,
          user_completed_at: statusId === "COMPLETED" ? todayIso : null,
        },
        `Moved ${targets.length} anime to ${label}`
      );
    };

    const handleBulkStepProgress = async (delta: number) => {
      onClose();
      await onBatchUpdate(
        {
          anime_ids: targetIds,
          progress_delta: delta,
        },
        `${delta > 0 ? "Incremented" : "Decremented"} episode progress (${
          delta > 0 ? `+${delta}` : delta
        }) for ${targets.length} anime`
      );
    };

    const handleApplyBulkNotes = async () => {
      onClose();
      await onBatchUpdate(
        {
          anime_ids: targetIds,
          user_notes: notesValue,
          notes_mode: notesMode,
        },
        `${notesMode === "append" ? "Appended" : "Updated"} notes for ${targets.length} anime`
      );
    };

    const handleApplyDateStarted = async (dateStr: string) => {
      onClose();
      await onBatchUpdate(
        {
          anime_ids: targetIds,
          user_started_at: dateStr,
        },
        dateStr
          ? `Set Date Started to ${dateStr} for ${targets.length} anime`
          : `Cleared Date Started for ${targets.length} anime`
      );
    };

    const handleApplyDateCompleted = async (dateStr: string) => {
      onClose();
      await onBatchUpdate(
        {
          anime_ids: targetIds,
          user_completed_at: dateStr,
        },
        dateStr
          ? `Set Date Completed to ${dateStr} for ${targets.length} anime`
          : `Cleared Date Completed for ${targets.length} anime`
      );
    };

    const handleApplyScore = async (sc: number) => {
      onClose();
      await onBatchUpdate(
        {
          anime_ids: targetIds,
          user_score: sc,
        },
        sc > 0
          ? `Set score to ${sc}/100 for ${targets.length} anime`
          : `Cleared score for ${targets.length} anime`
      );
    };

    const handleApplyExactProgress = async (prog: number) => {
      onClose();
      await onBatchUpdate(
        {
          anime_ids: targetIds,
          user_progress: Math.max(0, prog),
        },
        `Set progress to Ep ${Math.max(0, prog)} for ${targets.length} anime`
      );
    };

    const handleCopyAllTitles = async () => {
      onClose();
      try {
        const text = targets.map((a) => a.title_romaji).join("\n");
        await navigator.clipboard.writeText(text);
        showToast(`Copied ${targets.length} titles to clipboard`, "info");
      } catch {
        showToast("Failed to copy titles", "error");
      }
    };

    return (
      <div
        className="w-64 rounded-xl bg-bg-secondary/95 backdrop-blur-md border border-accent/40 shadow-2xl py-1.5 text-xs z-[100] select-none max-h-[calc(100vh-24px)] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {/* Multi-Select Header */}
        <div className="px-3 py-2 border-b border-border-subtle bg-accent/10">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex -space-x-2 overflow-hidden shrink-0">
                {targets.slice(0, 4).map((a) => (
                  <img
                    key={a.id}
                    src={getOptimizedCoverUrl(a.cover_image, "medium")}
                    alt={a.title_romaji}
                    className="inline-block w-6 h-8 rounded object-cover ring-1 ring-bg-secondary"
                  />
                ))}
              </div>
              <div className="min-w-0">
                <div className="font-bold text-text-primary flex items-center gap-1">
                  <Layers className="w-3.5 h-3.5 text-accent shrink-0" />
                  <span>{targets.length} Anime Selected</span>
                </div>
                <div className="text-[10px] text-text-muted font-mono truncate">
                  {totalOnDisk > 0 ? `${totalOnDisk} eps on disk` : "Batch actions"}
                </div>
              </div>
            </div>
            {onClearSelection && (
              <button
                onClick={() => {
                  onClearSelection();
                  onClose();
                }}
                className="p-1 rounded-md hover:bg-bg-tertiary text-text-muted hover:text-text-primary transition"
                title="Clear Selection (Esc)"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Quick Status Move Section */}
        <div className="py-1">
          <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-text-muted">
            Move Selected To
          </div>
          <div className="grid grid-cols-2 gap-1 px-2 py-0.5">
            {STATUS_OPTIONS.map((st) => {
              const Icon = st.icon;
              return (
                <button
                  key={st.id}
                  onClick={() => handleMoveStatus(st.id, st.label)}
                  className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-medium text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/90 transition text-left cursor-pointer"
                >
                  <Icon className={`w-3.5 h-3.5 shrink-0 ${st.color}`} />
                  <span className="truncate">{st.label}</span>
                </button>
              );
            })}
          </div>
          <button
            onClick={() => handleMoveStatus("COMPLETED", "Completed (100%)", true)}
            className={itemClass}
          >
            <span className="flex items-center gap-2">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              <span>Mark Completed & Max Episodes</span>
            </span>
          </button>
        </div>

        <div className="border-t border-border-subtle my-0.5" />

        {/* Bulk Episode Progress & Score */}
        <div className="py-1">
          <button onClick={() => handleBulkStepProgress(1)} className={itemClass}>
            <span className="flex items-center gap-2">
              <Plus className="w-3.5 h-3.5 text-emerald-400" />
              <span>Increment Episode (+1 All)</span>
            </span>
          </button>

          <button onClick={() => handleBulkStepProgress(-1)} className={itemClass}>
            <span className="flex items-center gap-2">
              <Minus className="w-3.5 h-3.5 text-text-muted" />
              <span>Decrement Episode (-1 All)</span>
            </span>
          </button>

          <button onClick={() => togglePanel("progress")} className={itemClass}>
            <span className="flex items-center gap-2">
              <Play className="w-3.5 h-3.5 text-accent" />
              <span>Set Episode Progress...</span>
            </span>
            {activePanel === "progress" ? (
              <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-text-muted" />
            )}
          </button>

          {activePanel === "progress" && (
            <div className="mx-2 my-1 p-2.5 rounded-lg bg-bg-primary border border-border-subtle space-y-2">
              <div className="flex items-center justify-between text-[10px] text-text-muted">
                <span>Set Episode # for {targets.length} anime</span>
                <button
                  onClick={() => handleApplyExactProgress(0)}
                  className="text-accent hover:underline font-semibold"
                >
                  Reset to 0
                </button>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={0}
                  max={9999}
                  value={progressValue}
                  onChange={(e) => setProgressValue(Number(e.target.value))}
                  className="w-full px-2 py-1 rounded bg-bg-secondary border border-border-subtle text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
                />
                <button
                  onClick={() => handleApplyExactProgress(progressValue)}
                  className="px-2.5 py-1 rounded bg-accent hover:bg-accent-hover text-white font-semibold text-[11px] shrink-0 flex items-center gap-1"
                >
                  <Check className="w-3 h-3" />
                  Apply
                </button>
              </div>
            </div>
          )}

          <button onClick={() => togglePanel("score")} className={itemClass}>
            <span className="flex items-center gap-2">
              <Star className="w-3.5 h-3.5 text-amber-400" />
              <span>Set Score...</span>
            </span>
            {activePanel === "score" ? (
              <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-text-muted" />
            )}
          </button>

          {activePanel === "score" && (
            <div className="mx-2 my-1 p-2.5 rounded-lg bg-bg-primary border border-border-subtle space-y-2">
              <div className="flex items-center justify-between gap-1">
                {[100, 90, 80, 70, 0].map((preset) => (
                  <button
                    key={preset}
                    onClick={() => handleApplyScore(preset)}
                    className="px-1.5 py-0.5 rounded bg-bg-secondary hover:bg-accent hover:text-white text-[10px] font-mono border border-border-subtle transition"
                  >
                    {preset === 0 ? "Clear" : preset}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={scoreValue}
                  onChange={(e) => setScoreValue(Number(e.target.value))}
                  className="w-full px-2 py-1 rounded bg-bg-secondary border border-border-subtle text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
                />
                <button
                  onClick={() => handleApplyScore(scoreValue)}
                  className="px-2.5 py-1 rounded bg-accent hover:bg-accent-hover text-white font-semibold text-[11px] shrink-0 flex items-center gap-1"
                >
                  <Check className="w-3 h-3" />
                  Apply
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-border-subtle my-0.5" />

        {/* Bulk Dates & Notes */}
        <div className="py-1">
          <button
            onClick={() => handleApplyDateStarted(todayIso)}
            className={itemClass}
          >
            <span className="flex items-center gap-2">
              <Calendar className="w-3.5 h-3.5 text-emerald-400" />
              <span>Set Date Started → Today</span>
            </span>
            <span className="font-mono text-[10px] text-text-muted">{todayIso}</span>
          </button>

          <button onClick={() => togglePanel("date_started")} className={itemClass}>
            <span className="flex items-center gap-2">
              <Calendar className="w-3.5 h-3.5 text-accent" />
              <span>Set Date Started...</span>
            </span>
            {activePanel === "date_started" ? (
              <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-text-muted" />
            )}
          </button>

          {activePanel === "date_started" && (
            <div className="mx-2 my-1 p-2.5 rounded-lg bg-bg-primary border border-border-subtle space-y-2">
              <div className="flex items-center justify-between text-[10px] text-text-muted">
                <span>Date Started</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setDateStartedValue(todayIso)}
                    className="text-accent hover:underline font-semibold"
                  >
                    Today
                  </button>
                  <button
                    onClick={() => handleApplyDateStarted("")}
                    className="text-red-400 hover:underline"
                  >
                    Clear
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="date"
                  value={dateStartedValue}
                  onChange={(e) => setDateStartedValue(e.target.value)}
                  className="w-full px-2 py-1 rounded bg-bg-secondary border border-border-subtle text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
                />
                <button
                  onClick={() => handleApplyDateStarted(dateStartedValue)}
                  className="px-2.5 py-1 rounded bg-accent hover:bg-accent-hover text-white font-semibold text-[11px] shrink-0 flex items-center gap-1"
                >
                  <Check className="w-3 h-3" />
                  Set
                </button>
              </div>
            </div>
          )}

          <button onClick={() => togglePanel("date_completed")} className={itemClass}>
            <span className="flex items-center gap-2">
              <Calendar className="w-3.5 h-3.5 text-sky-400" />
              <span>Set Date Completed...</span>
            </span>
            {activePanel === "date_completed" ? (
              <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-text-muted" />
            )}
          </button>

          {activePanel === "date_completed" && (
            <div className="mx-2 my-1 p-2.5 rounded-lg bg-bg-primary border border-border-subtle space-y-2">
              <div className="flex items-center justify-between text-[10px] text-text-muted">
                <span>Date Completed</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setDateCompletedValue(todayIso)}
                    className="text-accent hover:underline font-semibold"
                  >
                    Today
                  </button>
                  <button
                    onClick={() => handleApplyDateCompleted("")}
                    className="text-red-400 hover:underline"
                  >
                    Clear
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="date"
                  value={dateCompletedValue}
                  onChange={(e) => setDateCompletedValue(e.target.value)}
                  className="w-full px-2 py-1 rounded bg-bg-secondary border border-border-subtle text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
                />
                <button
                  onClick={() => handleApplyDateCompleted(dateCompletedValue)}
                  className="px-2.5 py-1 rounded bg-accent hover:bg-accent-hover text-white font-semibold text-[11px] shrink-0 flex items-center gap-1"
                >
                  <Check className="w-3 h-3" />
                  Set
                </button>
              </div>
            </div>
          )}

          <button onClick={() => togglePanel("notes")} className={itemClass}>
            <span className="flex items-center gap-2">
              <StickyNote className="w-3.5 h-3.5 text-amber-400" />
              <span>Set Notes...</span>
            </span>
            {activePanel === "notes" ? (
              <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-text-muted" />
            )}
          </button>

          {activePanel === "notes" && (
            <div className="mx-2 my-1 p-2.5 rounded-lg bg-bg-primary border border-border-subtle space-y-2">
              <div className="flex items-center justify-between gap-1 text-[10px]">
                <div className="flex items-center gap-1 bg-bg-secondary p-0.5 rounded border border-border-subtle">
                  <button
                    type="button"
                    onClick={() => setNotesMode("replace")}
                    className={`px-1.5 py-0.5 rounded transition ${
                      notesMode === "replace"
                        ? "bg-accent text-white font-semibold"
                        : "text-text-muted hover:text-text-primary"
                    }`}
                  >
                    Replace
                  </button>
                  <button
                    type="button"
                    onClick={() => setNotesMode("append")}
                    className={`px-1.5 py-0.5 rounded transition ${
                      notesMode === "append"
                        ? "bg-accent text-white font-semibold"
                        : "text-text-muted hover:text-text-primary"
                    }`}
                  >
                    Append
                  </button>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    onClose();
                    await onBatchUpdate(
                      {
                        anime_ids: targetIds,
                        user_notes: "",
                        notes_mode: "replace",
                      },
                      `Cleared notes for ${targets.length} anime`
                    );
                  }}
                  className="text-red-400 hover:underline"
                >
                  Clear All
                </button>
              </div>
              <textarea
                rows={2}
                value={notesValue}
                onChange={(e) => setNotesValue(e.target.value)}
                placeholder={
                  notesMode === "append"
                    ? "Text to append to notes..."
                    : "Set notes for selected anime..."
                }
                className="w-full px-2 py-1.5 rounded bg-bg-secondary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent"
              />
              <button
                onClick={handleApplyBulkNotes}
                className="w-full py-1.5 rounded bg-accent hover:bg-accent-hover text-white font-semibold text-[11px] flex items-center justify-center gap-1"
              >
                <Check className="w-3.5 h-3.5" />
                Save Notes ({targets.length} Anime)
              </button>
            </div>
          )}
        </div>

        <div className="border-t border-border-subtle my-0.5" />

        {/* Copy & Delete Selected */}
        <div className="py-1">
          <button onClick={handleCopyAllTitles} className={itemClass}>
            <span className="flex items-center gap-2">
              <Copy className="w-3.5 h-3.5 text-text-muted" />
              <span>Copy Selected Titles ({targets.length})</span>
            </span>
          </button>

          <button
            onClick={async () => {
              onClose();
              await onBatchDelete(targets);
            }}
            className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left text-xs text-red-400 hover:bg-red-500/15 transition cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <Trash2 className="w-3.5 h-3.5" />
              <span>Delete Selected from List</span>
            </span>
            <span className="font-mono text-[10px] px-1.5 py-0.2 rounded bg-red-500/20 text-red-300">
              {targets.length}
            </span>
          </button>
        </div>
      </div>
    );
  }

  // ============================================================================
  // SINGLE ANIME CONTEXT MENU (1 anime selected)
  // ============================================================================
  const nextEp = anime.user_progress + 1;
  const lastEp = anime.user_progress;
  const canStepForward =
    !anime.episodes || anime.user_progress < anime.episodes;
  const canStepBackward = anime.user_progress > 0;
  const hasNextOnDisk = anime.available_episodes.includes(nextEp);
  const hasLastOnDisk =
    lastEp > 0 && anime.available_episodes.includes(lastEp);
  const hasFolderOrFiles =
    Boolean(anime.custom_folder?.trim()) || anime.local_episode_count > 0;

  const handlePlayEpisode = async (targetEp: number, label: string) => {
    onClose();
    if (targetEp <= 0) return;
    try {
      const files = await toraApi.getLocalEpisodes(anime.id);
      if (files.length === 0) {
        showToast(
          `No local episode files found for "${anime.title_romaji}"`,
          "error"
        );
        return;
      }
      const match =
        files.find((f) => f.episode_number === targetEp) ||
        (targetEp === 1 && files.length === 1 ? files[0] : undefined);
      if (!match) {
        showToast(`Episode ${targetEp} not found on disk`, "error");
        return;
      }
      await toraApi.playEpisodeFile(match.file_path);
      showToast(`Playing ${label}: ${match.file_name}`, "info");
    } catch (e: any) {
      showToast(String(e), "error");
    }
  };

  const handleOpenFolder = async () => {
    onClose();
    try {
      if (anime.custom_folder && anime.custom_folder.trim()) {
        await toraApi.revealInExplorer(anime.custom_folder.trim());
        return;
      }
      const files = await toraApi.getLocalEpisodes(anime.id);
      if (files.length > 0) {
        await toraApi.revealInExplorer(files[0].file_path);
        return;
      }
      showToast(`No local folder linked for "${anime.title_romaji}"`, "error");
    } catch (e: any) {
      showToast(String(e), "error");
    }
  };

  const handleCopyTitle = async () => {
    onClose();
    try {
      await navigator.clipboard.writeText(anime.title_romaji);
      showToast(`Copied "${anime.title_romaji}"`, "info");
    } catch {
      showToast("Failed to copy title", "error");
    }
  };

  const handleSingleStatusChange = async (statusId: string, label: string) => {
    onClose();
    await onBatchUpdate(
      {
        anime_ids: [anime.id],
        user_status: statusId,
      },
      `Moved "${anime.title_romaji}" to ${label}`
    );
  };

  const handleSingleSaveDateStarted = async (dateStr: string) => {
    onClose();
    await onBatchUpdate(
      {
        anime_ids: [anime.id],
        user_started_at: dateStr,
      },
      dateStr
        ? `Set Date Started to ${dateStr} for "${anime.title_romaji}"`
        : `Cleared Date Started for "${anime.title_romaji}"`
    );
  };

  const handleSingleSaveNotes = async () => {
    onClose();
    await onBatchUpdate(
      {
        anime_ids: [anime.id],
        user_notes: notesValue,
        notes_mode: "replace",
      },
      `Saved notes for "${anime.title_romaji}"`
    );
  };

  return (
    <div
      className="w-60 rounded-xl bg-bg-secondary/95 backdrop-blur-md border border-border-subtle shadow-2xl py-1.5 text-xs z-[100] select-none max-h-[calc(100vh-24px)] overflow-y-auto"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* Compact Header */}
      <div className="px-3 py-1.5 border-b border-border-subtle">
        <div
          className="font-bold text-text-primary truncate"
          title={anime.title_romaji}
        >
          {anime.title_romaji}
        </div>
        <div className="flex items-center justify-between text-[10px] text-text-muted font-mono mt-0.5">
          <span>
            Ep {anime.user_progress} / {anime.episodes ?? "?"}
          </span>
          {anime.local_episode_count > 0 && (
            <span className="text-emerald-400">
              {anime.local_episode_count} on disk
            </span>
          )}
        </div>
      </div>

      {/* Playback & Folder Actions */}
      <div className="py-1">
        <button
          onClick={() => handlePlayEpisode(nextEp, `Episode ${nextEp}`)}
          disabled={!canStepForward}
          className={itemClass}
        >
          <span className="flex items-center gap-2">
            <Play className="w-3.5 h-3.5 text-accent fill-current" />
            <span>Play Next Episode</span>
          </span>
          <span
            className={`font-mono text-[10px] ${
              hasNextOnDisk ? "text-emerald-400 font-semibold" : "text-text-muted"
            }`}
          >
            Ep {nextEp}
          </span>
        </button>

        <button
          onClick={() => handlePlayEpisode(lastEp, `Episode ${lastEp}`)}
          disabled={lastEp <= 0}
          className={itemClass}
        >
          <span className="flex items-center gap-2">
            <History className="w-3.5 h-3.5 text-text-muted" />
            <span>Play Last Episode</span>
          </span>
          {lastEp > 0 && (
            <span
              className={`font-mono text-[10px] ${
                hasLastOnDisk
                  ? "text-emerald-400 font-semibold"
                  : "text-text-muted"
              }`}
            >
              Ep {lastEp}
            </span>
          )}
        </button>

        <button
          onClick={handleOpenFolder}
          disabled={!hasFolderOrFiles}
          className={itemClass}
        >
          <span className="flex items-center gap-2">
            <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
            <span>Open Folder</span>
          </span>
        </button>
      </div>

      <div className="border-t border-border-subtle my-0.5" />

      {/* Episode Step & Torrents */}
      <div className="py-1">
        <button
          onClick={() => {
            onStepEpisode(anime, 1);
            onClose();
          }}
          disabled={!canStepForward}
          className={itemClass}
        >
          <span className="flex items-center gap-2">
            <Plus className="w-3.5 h-3.5 text-emerald-400" />
            <span>Increment Episode (+1)</span>
          </span>
        </button>

        <button
          onClick={() => {
            onStepEpisode(anime, -1);
            onClose();
          }}
          disabled={!canStepBackward}
          className={itemClass}
        >
          <span className="flex items-center gap-2">
            <Minus className="w-3.5 h-3.5 text-text-muted" />
            <span>Decrement Episode (-1)</span>
          </span>
        </button>

        <button
          onClick={() => {
            onSearchTorrents(
              `${anime.title_romaji} ${String(nextEp).padStart(2, "0")}`
            );
            onClose();
          }}
          className={itemClass}
        >
          <span className="flex items-center gap-2">
            <Search className="w-3.5 h-3.5 text-accent" />
            <span>Search Torrents</span>
          </span>
          <span className="font-mono text-[10px] text-text-muted">
            #{String(nextEp).padStart(2, "0")}
          </span>
        </button>
      </div>

      <div className="border-t border-border-subtle my-0.5" />

      {/* Quick Move Status, Date Started & Notes */}
      <div className="py-1">
        <button onClick={() => togglePanel("status")} className={itemClass}>
          <span className="flex items-center gap-2">
            <Tv className="w-3.5 h-3.5 text-accent" />
            <span>Move to List...</span>
          </span>
          {activePanel === "status" ? (
            <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-text-muted" />
          )}
        </button>

        {activePanel === "status" && (
          <div className="mx-2 my-1 p-1.5 rounded-lg bg-bg-primary border border-border-subtle grid grid-cols-2 gap-1">
            {STATUS_OPTIONS.map((st) => {
              const Icon = st.icon;
              const isCurrent = anime.user_status === st.id;
              return (
                <button
                  key={st.id}
                  onClick={() => handleSingleStatusChange(st.id, st.label)}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded text-[11px] text-left transition cursor-pointer ${
                    isCurrent
                      ? "bg-accent/20 text-accent font-bold"
                      : "text-text-secondary hover:bg-bg-secondary hover:text-text-primary"
                  }`}
                >
                  <Icon className={`w-3 h-3 shrink-0 ${st.color}`} />
                  <span className="truncate">{st.label}</span>
                </button>
              );
            })}
          </div>
        )}

        <button onClick={() => togglePanel("date_started")} className={itemClass}>
          <span className="flex items-center gap-2">
            <Calendar className="w-3.5 h-3.5 text-emerald-400" />
            <span>Set Date Started...</span>
          </span>
          <span className="font-mono text-[10px] text-text-muted">
            {anime.user_started_at || "None"}
          </span>
        </button>

        {activePanel === "date_started" && (
          <div className="mx-2 my-1 p-2 rounded-lg bg-bg-primary border border-border-subtle space-y-1.5">
            <div className="flex items-center justify-between text-[10px] text-text-muted">
              <button
                onClick={() => handleSingleSaveDateStarted(todayIso)}
                className="text-accent hover:underline font-semibold"
              >
                Set Today ({todayIso})
              </button>
              {anime.user_started_at && (
                <button
                  onClick={() => handleSingleSaveDateStarted("")}
                  className="text-red-400 hover:underline"
                >
                  Clear
                </button>
              )}
            </div>
            <div className="flex items-center gap-1">
              <input
                type="date"
                value={dateStartedValue}
                onChange={(e) => setDateStartedValue(e.target.value)}
                className="w-full px-2 py-1 rounded bg-bg-secondary border border-border-subtle text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
              />
              <button
                onClick={() => handleSingleSaveDateStarted(dateStartedValue)}
                className="px-2 py-1 rounded bg-accent hover:bg-accent-hover text-white font-semibold text-[11px] shrink-0"
              >
                Save
              </button>
            </div>
          </div>
        )}

        <button onClick={() => togglePanel("notes")} className={itemClass}>
          <span className="flex items-center gap-2">
            <StickyNote className="w-3.5 h-3.5 text-amber-400" />
            <span>Set Notes...</span>
          </span>
          {anime.user_notes ? (
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
          ) : null}
        </button>

        {activePanel === "notes" && (
          <div className="mx-2 my-1 p-2 rounded-lg bg-bg-primary border border-border-subtle space-y-1.5">
            <textarea
              rows={2}
              value={notesValue}
              onChange={(e) => setNotesValue(e.target.value)}
              placeholder="Personal notes..."
              className="w-full px-2 py-1 rounded bg-bg-secondary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent"
            />
            <div className="flex items-center justify-end gap-1.5">
              <button
                onClick={handleSingleSaveNotes}
                className="px-2.5 py-1 rounded bg-accent hover:bg-accent-hover text-white font-semibold text-[11px] flex items-center gap-1"
              >
                <Check className="w-3 h-3" />
                Save Note
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-border-subtle my-0.5" />

      {/* Edit, Copy & Delete */}
      <div className="py-1">
        <button
          onClick={() => {
            onOpenFullModal(anime);
            onClose();
          }}
          className={itemClass}
        >
          <span className="flex items-center gap-2">
            <Pencil className="w-3.5 h-3.5 text-accent" />
            <span>Edit Details...</span>
          </span>
        </button>

        <button onClick={handleCopyTitle} className={itemClass}>
          <span className="flex items-center gap-2">
            <Copy className="w-3.5 h-3.5 text-text-muted" />
            <span>Copy Title</span>
          </span>
        </button>

        <button
          onClick={() => {
            onDeleteAnime(anime);
            onClose();
          }}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-red-400 hover:bg-red-500/15 transition cursor-pointer"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>Delete from List</span>
        </button>
      </div>
    </div>
  );
};
