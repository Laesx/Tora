import { AnimeEntry, FeatureSupport, TrackerDescriptor, TrackerFeature, TrackerLinks } from "./types";

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
  anime.site_url || trackerLink(links, "anime", anime.id);

/** Every feature only some trackers have, in the order Settings → Tracker lists them. */
export const TRACKER_FEATURES: { id: TrackerFeature; label: string; where: string }[] = [
  { id: "airing_schedule", label: "Airing schedule", where: "The Schedule tab" },
  { id: "next_episode", label: "Next episode countdown", where: "Airing dots, Now Playing, Stats" },
  { id: "characters", label: "Characters & voice actors", where: "Anime page" },
  { id: "staff", label: "Staff", where: "Anime page" },
  { id: "recommendations", label: "Recommendations", where: "Anime page" },
  { id: "source_material", label: "Source manga / novel", where: "Anime page, saga (“Based on”)" },
  { id: "custom_lists", label: "Custom lists", where: "Anime List, quick menus, Now Playing" },
  { id: "following", label: "Following", where: "Anime page: people you follow" },
  { id: "activity_history", label: "Activity import", where: "History, Stats" },
];

/** The tracker's support for `feature`, or null when it doesn't have it. */
export const featureSupport = (
  tracker: TrackerDescriptor | null | undefined,
  feature: TrackerFeature
): FeatureSupport | null => tracker?.features.find((f) => f.feature === feature) ?? null;

/** A tracker's short name for small badges ("AL", "MAL"); unknown ids show their first letters. */
export const trackerShortName = (id: string): string =>
  ({ anilist: "AL", mal: "MAL", kitsu: "KIT" } as Record<string, string>)[id] ?? id.slice(0, 3).toUpperCase();
