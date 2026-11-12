import { useEffect, useRef, useState } from "react";
import { AnimeEntry, LocalEpisodeFile } from "@/lib/types";
import { toraApi } from "@/lib/api";
import { useToast } from "@/contexts/toast";
import { useAnimeTitle } from "@/contexts/titles";
import { log } from "@/lib/log";

type UpdateArgs = Parameters<typeof toraApi.updateAnimeEntry>[0];

/**
 * The drawer's editable copy of a list entry: user fields, the files on disk and the saves.
 * A debounced ± step or a date being typed is flushed when the drawer closes or switches anime.
 */
export function useEntryEditor({
  anime,
  inList,
  onUpdated,
  onSavedInBackground,
}: {
  anime: AnimeEntry;
  inList: boolean;
  onUpdated: (updated: AnimeEntry) => void;
  onSavedInBackground?: (updated: AnimeEntry) => void;
}) {
  const showToast = useToast();
  const titleOf = useAnimeTitle();
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
  const stepSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The save a pending ± step will make, so closing the drawer (or switching anime) flushes it
  const pendingStepSaveRef = useRef<UpdateArgs | null>(null);
  const backgroundRef = useRef({ onSavedInBackground, showToast });
  backgroundRef.current = { onSavedInBackground, showToast };
  // The anime on screen; null once the drawer closed. A save that returns after that must not reopen it.
  const openAnimeIdRef = useRef<number | null>(anime.id);

  useEffect(() => {
    openAnimeIdRef.current = anime.id;
    return () => {
      openAnimeIdRef.current = null;
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
  }, [anime.id, anime.user_status, anime.user_progress, anime.user_score, anime.user_repeats]);

  // One at a time: a save returning for one date must not wipe the other while it's being typed
  useEffect(() => {
    setStartedAt(anime.user_started_at || "");
  }, [anime.id, anime.user_started_at]);

  useEffect(() => {
    setCompletedAt(anime.user_completed_at || "");
  }, [anime.id, anime.user_completed_at]);

  // Reload text inputs when switching to a different anime ID
  useEffect(() => {
    setNotes(anime.user_notes);
    setCustomFolder(anime.custom_folder || "");
    setSynonymsInput(anime.custom_synonyms.join(", "));
  }, [anime.id]);

  const loadLocalFiles = async (animeId: number) => {
    try {
      const files = await toraApi.getLocalEpisodes(animeId);
      if (openAnimeIdRef.current === animeId) setLocalFiles(files);
    } catch (e) {
      log.error("detail", "Failed to load local episodes for anime", e);
    }
  };

  // Reload local files when anime ID or matched episode count changes (only list entries have local files)
  useEffect(() => {
    if (inList) {
      loadLocalFiles(anime.id);
    } else {
      setLocalFiles([]);
    }
  }, [anime.id, anime.local_episode_count, inList]);

  const markWatchedUpTo = (nextProgress: number) =>
    setLocalFiles((prev) =>
      prev.map((f) => ({
        ...f,
        watched: f.episode_number !== null && f.episode_number <= nextProgress,
      }))
    );

  const handleSave = async (
    nextStatus = status,
    nextProgress = progress,
    nextScore = score,
    nextRepeats = repeats,
    includeMetadata = false,
    nextStartedAt = startedAt,
    nextCompletedAt = completedAt
  ) => {
    // This save sends the current state, so anything still pending would only overwrite it later
    if (stepSaveTimerRef.current) {
      clearTimeout(stepSaveTimerRef.current);
      stepSaveTimerRef.current = null;
    }
    pendingStepSaveRef.current = null;
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
      if (openAnimeIdRef.current !== anime.id) {
        backgroundRef.current.onSavedInBackground?.(updated);
        return;
      }
      onUpdated(updated);
      if (includeMetadata) {
        await loadLocalFiles(anime.id);
      } else {
        markWatchedUpTo(nextProgress);
      }
      showToast(`Saved changes for ${titleOf(anime)}`, "success");
    } catch (e: any) {
      showToast(String(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const pendingSave = (
    userStatus: string,
    userProgress: number,
    userStartedAt: string,
    userCompletedAt: string
  ): UpdateArgs => ({
    animeId: anime.id,
    userStatus,
    userProgress,
    userScore: score,
    userRepeats: repeats,
    userNotes: notes,
    customFolder: customFolder.trim() || null,
    synonyms: null,
    userStartedAt: userStartedAt.trim(),
    userCompletedAt: userCompletedAt.trim(),
  });

  const stepEpisode = (delta: number) => {
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
    markWatchedUpTo(nextProg);

    if (stepSaveTimerRef.current) {
      clearTimeout(stepSaveTimerRef.current);
    }
    pendingStepSaveRef.current = pendingSave(nextStat, nextProg, startedAt, completedAt);
    stepSaveTimerRef.current = setTimeout(() => {
      stepSaveTimerRef.current = null;
      pendingStepSaveRef.current = null;
      handleSave(nextStat, nextProg, score, repeats, false);
    }, 1200);
  };

  /** A date being edited: only remembered, so closing the drawer or switching anime still saves it */
  const stageDates = (nextStartedAt: string, nextCompletedAt: string) => {
    if (stepSaveTimerRef.current) {
      clearTimeout(stepSaveTimerRef.current);
      stepSaveTimerRef.current = null;
    }
    pendingStepSaveRef.current = pendingSave(status, progress, nextStartedAt, nextCompletedAt);
  };

  /** The user left a date field: save once, and only if something changed */
  const commitDates = (nextStartedAt: string, nextCompletedAt: string) => {
    const unchanged =
      nextStartedAt === (anime.user_started_at || "") &&
      nextCompletedAt === (anime.user_completed_at || "") &&
      status === anime.user_status &&
      progress === anime.user_progress;
    if (unchanged) {
      pendingStepSaveRef.current = null;
      return;
    }
    handleSave(status, progress, score, repeats, false, nextStartedAt, nextCompletedAt);
  };

  return {
    status,
    setStatus,
    progress,
    setProgress,
    score,
    setScore,
    repeats,
    setRepeats,
    notes,
    setNotes,
    startedAt,
    setStartedAt,
    completedAt,
    setCompletedAt,
    customFolder,
    setCustomFolder,
    synonymsInput,
    setSynonymsInput,
    localFiles,
    saving,
    handleSave,
    stepEpisode,
    stageDates,
    commitDates,
  };
}

export type EntryEditor = ReturnType<typeof useEntryEditor>;
