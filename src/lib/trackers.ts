import { AnimeEntry, TrackerLinks } from "./types";

export type TrackerLinkKind = keyof TrackerLinks;

/**
 * A tracker page's URL from its template (`{id}` → the id, `{name}` → the URL-encoded name); null when the
 * tracker has no such page (show plain text then).
 */
export function trackerLink(
  links: TrackerLinks | null | undefined,
  kind: TrackerLinkKind,
  value: string | number
): string | null {
  const template = links?.[kind];
  if (!template) return null;
  return template.replace("{id}", String(value)).replace("{name}", encodeURIComponent(String(value)));
}

/** The anime's page on the tracker: the URL it sent, else the tracker's template. */
export const trackerAnimeUrl = (links: TrackerLinks | null | undefined, anime: AnimeEntry): string | null =>
  anime.site_url || trackerLink(links, "anime", anime.anilist_id ?? anime.id);
