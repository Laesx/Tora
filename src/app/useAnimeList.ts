import { useCallback, useState } from "react";
import { AnimeEntry, BatchAnimeUpdatePatch } from "@/lib/types";
import { toraApi } from "@/lib/api";
import type { ShowToast } from "@/contexts/toast";

/**
 * The user's list plus the UI state that points into it (open drawer, selection, quick menu),
 * kept consistent on every change. Every function returned is stable.
 */
export function useAnimeList(showToast: ShowToast, titleOf: (a: AnimeEntry) => string) {
  const [animeList, setAnimeList] = useState<AnimeEntry[]>([]);
  const [selectedAnime, setSelectedAnime] = useState<AnimeEntry | null>(null);
  const [selectedAnimeIds, setSelectedAnimeIds] = useState<number[]>([]);
  const [quickMenuAnimeId, setQuickMenuAnimeId] = useState<number | null>(null);

  /** Replaces the whole list; the open drawer follows its entry (a remote anime stays open) */
  const setList = useCallback((list: AnimeEntry[]) => {
    setAnimeList(list);
    setSelectedAnime((prev) => (prev ? list.find((a) => a.id === prev.id) ?? prev : null));
  }, []);

  const refresh = useCallback(async () => setList(await toraApi.getAnimeList()), [setList]);

  /** Swaps in newer copies of entries already in the list (unknown ids are ignored) */
  const replaceEntries = useCallback((entries: AnimeEntry[]) => {
    if (entries.length === 0) return;
    const byId = new Map(entries.map((e) => [e.id, e]));
    setAnimeList((prev) => prev.map((a) => byId.get(a.id) ?? a));
    setSelectedAnime((prev) => (prev ? byId.get(prev.id) ?? prev : null));
  }, []);

  /** Applies a delta in place (idempotent): changed entries replace or append, removed ids leave every view */
  const applyDelta = useCallback((changed: AnimeEntry[], removedIds: Iterable<number> = []) => {
    const removed = new Set(removedIds);
    if (changed.length === 0 && removed.size === 0) return;
    const changedById = new Map(changed.map((e) => [e.id, e]));
    setAnimeList((prev) => {
      const seen = new Set<number>();
      const next: AnimeEntry[] = [];
      for (const a of prev) {
        if (removed.has(a.id)) continue;
        const replacement = changedById.get(a.id);
        if (replacement) seen.add(a.id);
        next.push(replacement ?? a);
      }
      for (const e of changed) {
        if (!seen.has(e.id) && !removed.has(e.id)) next.push(e);
      }
      return next;
    });
    setSelectedAnime((prev) => {
      if (!prev) return prev;
      if (removed.has(prev.id)) return null;
      return changedById.get(prev.id) ?? prev;
    });
    if (removed.size > 0) {
      setSelectedAnimeIds((prev) =>
        prev.some((id) => removed.has(id)) ? prev.filter((id) => !removed.has(id)) : prev
      );
      setQuickMenuAnimeId((prev) => (prev !== null && removed.has(prev) ? null : prev));
    }
  }, []);

  /** Refetches only these entries (after a scan, scrobble or binding) instead of the whole list */
  const refreshEntries = useCallback(
    async (ids: number[]) => {
      if (ids.length > 0) applyDelta(await toraApi.getAnimeEntries(ids));
    },
    [applyDelta]
  );

  /** Empties everything (account switch) */
  const clear = useCallback(() => {
    setAnimeList([]);
    setSelectedAnime(null);
    setSelectedAnimeIds([]);
    setQuickMenuAnimeId(null);
  }, []);

  const deleteAnime = useCallback(
    async (anime: AnimeEntry) => {
      try {
        await toraApi.deleteAnimeEntry(anime.id);
        applyDelta([], [anime.id]);
        showToast(`Removed "${titleOf(anime)}" from list`, "info");
      } catch (e) {
        showToast(String(e), "error");
      }
    },
    [applyDelta, showToast, titleOf]
  );

  const batchDelete = useCallback(
    async (targets: AnimeEntry[]) => {
      if (targets.length === 0) return;
      const ids = targets.map((a) => a.id);
      try {
        await toraApi.batchDeleteAnimeEntries(ids);
        applyDelta([], ids);
        showToast(`Removed ${targets.length} anime from list`, "info");
      } catch (e) {
        showToast(String(e), "error");
      }
    },
    [applyDelta, showToast]
  );

  const batchUpdate = useCallback(
    async (patch: BatchAnimeUpdatePatch, summaryToast: string) => {
      try {
        replaceEntries(await toraApi.batchUpdateAnimeEntries(patch));
        showToast(summaryToast, "success");
      } catch (e) {
        showToast(String(e), "error");
      }
    },
    [replaceEntries, showToast]
  );

  /** Adds a remote (Seasons / Search / Schedule) anime with an instant optimistic update */
  const addAnime = useCallback(
    async (entry: AnimeEntry, status: "CURRENT" | "PLANNING") => {
      const optimistic: AnimeEntry = {
        ...entry,
        user_status: status,
        updated_at: Math.floor(Date.now() / 1000),
      };
      applyDelta([optimistic]);
      showToast(
        `Added "${titleOf(entry)}" to ${status === "CURRENT" ? "Watching" : "Planning"}`,
        "success"
      );
      try {
        applyDelta([await toraApi.addOrUpsertAnime(optimistic)]);
      } catch (err) {
        setAnimeList((prev) => prev.filter((a) => a.id !== entry.id));
        showToast(String(err), "error");
      }
    },
    [applyDelta, showToast, titleOf]
  );

  return {
    animeList,
    setAnimeList,
    selectedAnime,
    setSelectedAnime,
    selectedAnimeIds,
    setSelectedAnimeIds,
    quickMenuAnimeId,
    setQuickMenuAnimeId,
    setList,
    refresh,
    refreshEntries,
    replaceEntries,
    applyDelta,
    clear,
    deleteAnime,
    batchDelete,
    batchUpdate,
    addAnime,
  };
}

export type AnimeListStore = ReturnType<typeof useAnimeList>;
