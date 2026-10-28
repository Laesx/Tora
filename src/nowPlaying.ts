import { AnimeEntry, MediaRanking } from "./types";
import { toraApi } from "./api";
import { seasonName } from "./seasons";

type ShowToast = (msg: string, type?: "success" | "info" | "error") => void;

const ANILIST = "https://anilist.co";

export const anilistAnimeUrl = (anime: AnimeEntry) =>
  anime.site_url || `${ANILIST}/anime/${anime.anilist_id ?? anime.id}`;
export const anilistStudioUrl = (id: number) => `${ANILIST}/studio/${id}`;
export const anilistGenreUrl = (genre: string) =>
  `${ANILIST}/search/anime/${encodeURIComponent(genre)}`;
export const anilistTagUrl = (tag: string) =>
  `${ANILIST}/search/anime?genres=${encodeURIComponent(tag)}`;

export async function openExternal(url: string, showToast: ShowToast) {
  try {
    await toraApi.openExternalUrl(url);
  } catch (e) {
    showToast(String(e), "error");
  }
}

/** Play episode `ep` of `anime` from the local library. */
export async function playLocalEpisode(anime: AnimeEntry, ep: number, showToast: ShowToast) {
  try {
    const files = await toraApi.getLocalEpisodes(anime.id);
    const match =
      files.find((f) => f.episode_number === ep) ||
      (ep === 1 && files.length === 1 ? files[0] : undefined);
    if (!match) {
      showToast(`Episode ${ep} of "${anime.title_romaji}" not found on disk`, "error");
      return;
    }
    await toraApi.playEpisodeFile(match.file_path);
    showToast(`Playing ${anime.title_romaji} — Episode ${ep}`, "info");
  } catch (e) {
    showToast(String(e), "error");
  }
}

/** Open the anime's linked folder, or the folder of its first local file. */
export async function openAnimeFolder(anime: AnimeEntry, showToast: ShowToast) {
  try {
    if (anime.custom_folder?.trim()) {
      await toraApi.revealInExplorer(anime.custom_folder.trim());
      return;
    }
    const files = await toraApi.getLocalEpisodes(anime.id);
    if (files.length > 0) {
      await toraApi.revealInExplorer(files[0].file_path);
      return;
    }
    showToast(`No local folder linked for "${anime.title_romaji}"`, "error");
  } catch (e) {
    showToast(String(e), "error");
  }
}

/** Episodes on disk past the user's progress. */
export const unwatchedOnDisk = (anime: AnimeEntry) =>
  anime.available_episodes.filter((ep) => ep > anime.user_progress);

const ENUM_LABELS: Record<string, string> = {
  RELEASING: "Airing",
  FINISHED: "Finished",
  NOT_YET_RELEASED: "Not yet aired",
  CANCELLED: "Cancelled",
  HIATUS: "On hiatus",
  TV_SHORT: "TV Short",
  ONA: "ONA",
  OVA: "OVA",
  TV: "TV",
};

/** `LIGHT_NOVEL` → `Light Novel` (with a few AniList-specific labels). */
export function formatEnum(value: string | null | undefined): string {
  if (!value) return "—";
  if (ENUM_LABELS[value]) return ENUM_LABELS[value];
  return value
    .split("_")
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(" ");
}

/** Local `Date` of a fuzzy `YYYY-MM-DD` date; `null` unless the day is known. */
export function fuzzyDateToDate(value: string | null | undefined): Date | null {
  const m = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** `2026-07-04` → localized date, `2026-07` → `Jul 2026`, `2026` → `2026`. */
export function formatFuzzyDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const full = fuzzyDateToDate(value);
  if (full) return full.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const m = value.match(/^(\d{4})-(\d{2})$/);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
    });
  }
  return value;
}

/** `#3 Highest Rated Summer 2026`, `#120 Most Popular All Time` */
export function formatRanking(r: MediaRanking): string {
  const context = r.context.replace(/\b\w/g, (c) => c.toUpperCase());
  const scope = r.all_time
    ? "All Time"
    : [r.season ? seasonName(r.season) : null, r.year].filter(Boolean).join(" ");
  return `#${r.rank} ${context}${scope ? ` ${scope}` : ""}`;
}

/** `95` minutes → `1h 35m` */
export function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
