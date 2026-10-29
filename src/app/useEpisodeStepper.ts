import { useCallback, useRef, useState } from "react";
import { AnimeEntry } from "@/lib/types";
import { toraApi } from "@/lib/api";
import type { ShowToast } from "@/contexts/toast";

/** What a card looked like before its first pending click; sorting and filtering keep using it */
export interface StepSnapshot {
  initialStatus: string;
  initialProgress: number;
  initialUpdatedAt: number;
}

interface PendingStep extends StepSnapshot {
  latestAnime: AnimeEntry;
  timer: ReturnType<typeof setTimeout>;
}

const SAVE_DELAY_MS = 1400;

/**
 * Optimistic +1 / -1: the counter updates in 0ms, rapid clicks are coalesced into one save once
 * clicking stops, and the card keeps its list position and tab until then (`snapshots`).
 */
export function useEpisodeStepper(
  replaceEntries: (entries: AnimeEntry[]) => void,
  showToast: ShowToast,
  titleOf: (a: AnimeEntry) => string
) {
  const pendingRef = useRef<Record<number, PendingStep>>({});
  const [snapshots, setSnapshots] = useState<Record<number, StepSnapshot>>({});
  // The save timer reads the title language at save time
  const titleRef = useRef(titleOf);
  titleRef.current = titleOf;

  const isPending = useCallback((id: number) => Boolean(pendingRef.current[id]), []);

  /** Drops pending steps without saving (entries removed, account switched); all when `ids` is omitted */
  const cancel = useCallback((ids?: Iterable<number>) => {
    const dropped: number[] = [];
    for (const id of ids ?? Object.keys(pendingRef.current).map(Number)) {
      const pending = pendingRef.current[id];
      if (!pending) continue;
      clearTimeout(pending.timer);
      delete pendingRef.current[id];
      dropped.push(id);
    }
    if (dropped.length === 0) return;
    setSnapshots((prev) => {
      const next = { ...prev };
      for (const id of dropped) delete next[id];
      return next;
    });
  }, []);

  const save = useCallback(
    async (id: number) => {
      const current = pendingRef.current[id];
      delete pendingRef.current[id];
      setSnapshots((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      if (!current) return;

      const anime = current.latestAnime;
      const progress = anime.user_progress;
      let status = current.initialStatus;
      if (anime.episodes && progress >= anime.episodes) status = "COMPLETED";
      else if (progress > 0 && current.initialStatus === "PLANNING") status = "CURRENT";

      showToast(`${titleRef.current(anime)} → Episode ${progress}`, "success");
      try {
        const updated = await toraApi.updateAnimeEntry({
          animeId: anime.id,
          userStatus: status,
          userProgress: progress,
          userScore: anime.user_score,
          userRepeats: anime.user_repeats,
          userNotes: anime.user_notes,
          customFolder: anime.custom_folder,
        });
        replaceEntries([updated]);
      } catch (err) {
        showToast(String(err), "error");
      }
    },
    [replaceEntries, showToast]
  );

  const stepEpisode = useCallback(
    (anime: AnimeEntry, delta: number) => {
      const existing = pendingRef.current[anime.id];
      const base = existing ? existing.latestAnime : anime;
      const progress = Math.max(0, Math.min(base.episodes || 9999, base.user_progress + delta));
      if (existing) clearTimeout(existing.timer);

      const snapshot: StepSnapshot = existing ?? {
        initialStatus: anime.user_status,
        initialProgress: anime.user_progress,
        initialUpdatedAt: anime.updated_at,
      };
      // Status and updated_at stay as they were so the card doesn't move while clicking
      const optimistic: AnimeEntry = {
        ...base,
        user_progress: progress,
        user_status: snapshot.initialStatus,
        updated_at: snapshot.initialUpdatedAt,
      };
      replaceEntries([optimistic]);
      if (!existing) {
        setSnapshots((prev) => ({
          ...prev,
          [anime.id]: {
            initialStatus: snapshot.initialStatus,
            initialProgress: snapshot.initialProgress,
            initialUpdatedAt: snapshot.initialUpdatedAt,
          },
        }));
      }
      pendingRef.current[anime.id] = {
        initialStatus: snapshot.initialStatus,
        initialProgress: snapshot.initialProgress,
        initialUpdatedAt: snapshot.initialUpdatedAt,
        latestAnime: optimistic,
        timer: setTimeout(() => void save(anime.id), SAVE_DELAY_MS),
      };
    },
    [replaceEntries, save]
  );

  return { stepEpisode, snapshots, isPending, cancel };
}
