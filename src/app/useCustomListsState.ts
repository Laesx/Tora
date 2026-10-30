import { useCallback, useMemo, useState } from "react";
import { AnimeEntry, CustomListChange, CustomListMember, CustomListsState } from "@/lib/types";
import { toraApi } from "@/lib/api";
import { applyCustomListChangeLocally, CustomListsApi, EMPTY_CUSTOM_LISTS } from "@/contexts/customLists";
import { log } from "@/lib/log";

/**
 * AniList custom lists, kept beside the list (never in AnimeEntry, so search and matching don't
 * see them). `api` is what CustomListsContext provides.
 */
export function useCustomListsState(animeList: AnimeEntry[]) {
  const [state, setState] = useState<CustomListsState>(EMPTY_CUSTOM_LISTS);

  const refresh = useCallback(() => {
    toraApi
      .getCustomLists()
      .then(setState)
      .catch((e) => log.error("custom-lists", "Failed to load custom lists", e));
  }, []);

  const clear = useCallback(() => setState(EMPTY_CUSTOM_LISTS), []);

  const members = useMemo(
    () => new Map<number, CustomListMember>(state.members.map((m) => [m.anime_id, m])),
    [state]
  );
  // Entries hidden from status lists only show in their custom lists, All Anime and search
  const hiddenFromStatusIds = useMemo(
    () => new Set(state.members.filter((m) => m.hidden_from_status_lists).map((m) => m.anime_id)),
    [state]
  );
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const a of animeList) {
      for (const name of members.get(a.id)?.lists ?? []) result.set(name, (result.get(name) ?? 0) + 1);
    }
    return result;
  }, [animeList, members]);

  // Optimistic membership edit; the backend queues and pushes it like any other edit
  const apply = useCallback(
    async (change: CustomListChange) => {
      setState((prev) => applyCustomListChangeLocally(prev, change));
      try {
        setState(await toraApi.setAnimeCustomLists(change));
      } catch (err) {
        refresh();
        throw err;
      }
    },
    [refresh]
  );

  // Not optimistic: AniList must accept the list first (errors reach the caller)
  const create = useCallback(async (name: string) => {
    setState(await toraApi.createCustomList(name));
  }, []);
  const remove = useCallback(async (name: string) => {
    setState(await toraApi.deleteCustomList(name));
  }, []);

  const api = useMemo<CustomListsApi>(
    () => ({ names: state.names, membership: (id) => members.get(id), apply }),
    [state, members, apply]
  );

  return { names: state.names, members, hiddenFromStatusIds, counts, api, refresh, clear, create, remove };
}
