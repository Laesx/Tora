import { MediaTag, SeasonalAnime } from "@/lib/types";

/** Tags below this relevance say little about a show, so they are neither shown nor filtered on */
const TAG_MIN_RANK = 50;

export type TagFilterState = "include" | "exclude" | null;

export interface TagOption {
  name: string;
  count: number;
}

/** The anime's relevant, non-spoiler tags, most relevant first */
export function relevantTags(item: SeasonalAnime): MediaTag[] {
  return item.metadata.tags
    .filter((t) => !t.is_spoiler && (t.rank ?? 0) >= TAG_MIN_RANK)
    .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
}

/** Every included name is on the anime and no excluded one is */
export function matchesTagFilters(item: SeasonalAnime, include: string[], exclude: string[]): boolean {
  if (include.length === 0 && exclude.length === 0) return true;
  const terms = new Set([...item.genres, ...relevantTags(item).map((t) => t.name)]);
  return include.every((n) => terms.has(n)) && !exclude.some((n) => terms.has(n));
}

/** Genres and tags of a season with how many anime have them, most common first */
export function tagOptions(items: SeasonalAnime[]): { genres: TagOption[]; tags: TagOption[] } {
  const genres = new Map<string, number>();
  const tags = new Map<string, number>();
  for (const item of items) {
    for (const g of item.genres) genres.set(g, (genres.get(g) ?? 0) + 1);
    for (const t of relevantTags(item)) tags.set(t.name, (tags.get(t.name) ?? 0) + 1);
  }
  const sorted = (counts: Map<string, number>) =>
    [...counts]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { genres: sorted(genres), tags: sorted(tags) };
}
