import { AnimeEntry, HistoryTitleFilter, HistoryTitles } from "@/lib/types";
import { buildSearchIndex, search, SearchRecord } from "@/lib/fuzzy";

export type HistoryTitleIndex = SearchRecord<HistoryTitles>[];

/** Every title of the anime in the History: logged or imported ones, plus the list entry's titles and synonyms. */
export function buildHistoryTitleIndex(rows: HistoryTitles[], animeList: AnimeEntry[]): HistoryTitleIndex {
  const entries = new Map(animeList.map((a) => [a.id, a]));
  return buildSearchIndex(rows, (row) => {
    const entry = row.media_id !== null ? entries.get(row.media_id) : undefined;
    return entry
      ? [...row.titles, entry.title_romaji, entry.title_english, entry.title_native, ...entry.synonyms]
      : row.titles;
  });
}

/** The anime matching `query`, as the backend's filter. */
export function matchHistoryTitles(index: HistoryTitleIndex, query: string): HistoryTitleFilter {
  const filter: HistoryTitleFilter = { ids: [], titles: [] };
  for (const { item } of search(index, query)) {
    if (item.media_id !== null) filter.ids.push(item.media_id);
    else filter.titles.push(...item.titles);
  }
  return filter;
}
