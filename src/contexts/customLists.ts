import { createContext, useContext } from "react";
import { CustomListChange, CustomListMember, CustomListsState } from "@/lib/types";

// AniList custom lists, kept out of AnimeEntry / the search index / the matcher.
// App owns the state and provides it here so menus and the drawer need no extra props.

export interface CustomListsApi {
  // List names in the user's AniList order (empty when the user has none)
  names: string[];
  membership: (animeId: number) => CustomListMember | undefined;
  // Optimistic: the state updates immediately, then the change is saved and pushed
  apply: (change: CustomListChange) => Promise<void>;
}

export const CustomListsContext = createContext<CustomListsApi>({
  names: [],
  membership: () => undefined,
  apply: async () => { },
});

export const useCustomLists = () => useContext(CustomListsContext);

export const EMPTY_CUSTOM_LISTS: CustomListsState = { names: [], members: [] };

/** Mirror of the backend edit (`apply_custom_list_change`) for the optimistic update. */
export function applyCustomListChangeLocally(
  state: CustomListsState,
  change: CustomListChange
): CustomListsState {
  const byId = new Map(state.members.map((m) => [m.anime_id, m]));
  const order = (name: string) => {
    const i = state.names.indexOf(name);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  for (const id of change.anime_ids) {
    const current = byId.get(id);
    let lists = current ? [...current.lists] : [];
    for (const t of change.toggles) {
      if (t.enabled) {
        if (!lists.includes(t.name)) lists.push(t.name);
      } else {
        lists = lists.filter((n) => n !== t.name);
      }
    }
    lists.sort((a, b) => order(a) - order(b));
    const hidden =
      lists.length > 0 &&
      (change.hidden_from_status_lists ?? current?.hidden_from_status_lists ?? false);
    if (lists.length === 0 && !hidden) byId.delete(id);
    else byId.set(id, { anime_id: id, lists, hidden_from_status_lists: hidden });
  }
  return { names: state.names, members: Array.from(byId.values()) };
}

/** How many of `animeIds` are in `name`: "all", "some" or "none". */
export function listCoverage(
  api: CustomListsApi,
  animeIds: number[],
  name: string
): "all" | "some" | "none" {
  const n = animeIds.filter((id) => api.membership(id)?.lists.includes(name)).length;
  return n === 0 ? "none" : n === animeIds.length ? "all" : "some";
}
