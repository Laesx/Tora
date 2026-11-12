import { useEffect, useSyncExternalStore } from "react";
import { LocalEpisodeFile } from "./types";
import { toraApi } from "./api";
import { log } from "./log";

/**
 * Releases of one anime's files on disk, and which file plays an episode.
 *
 * A release is a folder. A folder is split by release group only when two groups both hold the same
 * episode there (English and Spanish copies side by side); groups that only take turns (an airing show
 * downloaded from whoever released first) stay one release.
 *
 * Without a pinned release the oldest one on disk plays (its earliest file date): the release that was
 * there first, which a newer download never displaces.
 */

export interface Release {
  /** `<folder key>|<group>`, or `<folder key>|*` for a whole folder; stored as the anime's preference */
  key: string;
  /** Parent folder as on disk */
  folder: string;
  folderName: string;
  drive: string;
  /** Release groups, most files first */
  groups: string[];
  /** Most common resolution */
  resolution: string | null;
  /** Every file of the release, extras included */
  files: LocalEpisodeFile[];
  /** Episode numbers it holds */
  episodes: Set<number>;
  totalBytes: number;
  /** Earliest file date (unix seconds) */
  oldest: number;
}

export type ExtraKind = "opening" | "ending" | "preview" | "special" | "recap" | "other";

export const EXTRA_KIND_LABELS: Record<ExtraKind, string> = {
  special: "Specials & OVAs",
  recap: "Recaps",
  opening: "Openings",
  ending: "Endings",
  preview: "Previews & trailers",
  other: "Other",
};

export const EXTRA_KIND_ORDER: ExtraKind[] = ["special", "recap", "opening", "ending", "preview", "other"];

const NO_GROUP = "";
const WHOLE_FOLDER = "*";

const parentDir = (path: string) => {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i > 0 ? path.slice(0, i) : path;
};

const folderKey = (dir: string) => dir.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

const keyFolder = (key: string) => key.slice(0, key.lastIndexOf("|"));

/** The episode a file plays: its number, or 1 for the single unnumbered file of a one-episode anime. */
export function episodeOf(file: LocalEpisodeFile, totalEpisodes: number | null): number | null {
  if (file.episode_number !== null) return file.episode_number;
  return totalEpisodes === 1 && !file.extra_kind ? 1 : null;
}

export const extraKindOf = (file: LocalEpisodeFile): ExtraKind => file.extra_kind ?? "other";

/** Height of a resolution label ("1080p", "1920x1080", "4K") for ranking; 0 when unknown. */
export function resolutionHeight(resolution: string | null): number {
  if (!resolution) return 0;
  const r = resolution.toLowerCase();
  if (r === "4k" || r === "2160p") return 2160;
  const x = /\d{3,4}\s*x\s*(\d{3,4})/.exec(r);
  if (x) return Number(x[1]);
  const p = /(\d{3,4})[pi]?/.exec(r);
  return p ? Number(p[1]) : 0;
}

const mostCommon = (values: (string | null)[]): string[] => {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
};

/** One anime's files as releases, oldest first. */
export function groupReleases(files: LocalEpisodeFile[], totalEpisodes: number | null): Release[] {
  const byFolder = new Map<string, LocalEpisodeFile[]>();
  for (const f of files) {
    const key = folderKey(parentDir(f.file_path));
    const list = byFolder.get(key);
    if (list) list.push(f);
    else byFolder.set(key, [f]);
  }

  const releases: Release[] = [];
  for (const [fkey, folderFiles] of byFolder) {
    // Episodes per group: two groups with a common episode are two releases
    const episodesByGroup = new Map<string, Set<number>>();
    for (const f of folderFiles) {
      const ep = episodeOf(f, totalEpisodes);
      if (ep === null) continue;
      const group = f.release_group ?? NO_GROUP;
      const set = episodesByGroup.get(group) ?? new Set<number>();
      set.add(ep);
      episodesByGroup.set(group, set);
    }
    const seen = new Set<number>();
    let overlap = false;
    for (const set of episodesByGroup.values()) {
      for (const ep of set) {
        if (seen.has(ep)) overlap = true;
        seen.add(ep);
      }
    }

    const parts = new Map<string, LocalEpisodeFile[]>();
    for (const f of folderFiles) {
      const part = overlap ? f.release_group ?? NO_GROUP : WHOLE_FOLDER;
      const list = parts.get(part);
      if (list) list.push(f);
      else parts.set(part, [f]);
    }

    for (const [part, partFiles] of parts) {
      const folder = parentDir(partFiles[0].file_path);
      const episodes = new Set<number>();
      let totalBytes = 0;
      let oldest = Number.MAX_SAFE_INTEGER;
      for (const f of partFiles) {
        const ep = episodeOf(f, totalEpisodes);
        if (ep !== null) episodes.add(ep);
        totalBytes += f.file_size;
        if (f.modified_unix > 0) oldest = Math.min(oldest, f.modified_unix);
      }
      releases.push({
        key: `${fkey}|${part}`,
        folder,
        folderName: folder.slice(Math.max(folder.lastIndexOf("\\"), folder.lastIndexOf("/")) + 1) || folder,
        drive: partFiles[0].drive_root,
        groups: mostCommon(partFiles.map((f) => f.release_group)),
        resolution: mostCommon(partFiles.map((f) => f.resolution))[0] ?? null,
        files: partFiles,
        episodes,
        totalBytes,
        oldest,
      });
    }
  }

  return releases.sort((a, b) => a.oldest - b.oldest || a.key.localeCompare(b.key));
}

/**
 * The release that plays: the pinned one; else, when the pinned folder was split (or merged) since, the
 * oldest release of that folder; else the oldest release on disk.
 */
export function effectiveRelease(releases: Release[], pinned: string | null): Release | null {
  if (releases.length === 0) return null;
  if (pinned) {
    const exact = releases.find((r) => r.key === pinned);
    if (exact) return exact;
    const folder = keyFolder(pinned);
    const sameFolder = releases.find((r) => keyFolder(r.key) === folder);
    if (sameFolder) return sameFolder;
  }
  return releases[0];
}

/** Releases in the order they are tried for an episode: the one that plays, then the most complete. */
function playOrder(releases: Release[], pinned: string | null): Release[] {
  const first = effectiveRelease(releases, pinned);
  const rest = releases
    .filter((r) => r !== first)
    .sort(
      (a, b) =>
        b.episodes.size - a.episodes.size ||
        resolutionHeight(b.resolution) - resolutionHeight(a.resolution) ||
        a.oldest - b.oldest
    );
  return first ? [first, ...rest] : rest;
}

/** The newest file of `release` for episode `ep` (a v2 replaces a v1). */
export function releaseFile(release: Release, ep: number, totalEpisodes: number | null): LocalEpisodeFile | undefined {
  let best: LocalEpisodeFile | undefined;
  for (const f of release.files) {
    if (episodeOf(f, totalEpisodes) !== ep) continue;
    if (!best || f.modified_unix > best.modified_unix) best = f;
  }
  return best;
}

/** The file that plays episode `ep`: from the pinned (or oldest) release, else the most complete one. */
export function pickEpisodeFile(
  files: LocalEpisodeFile[],
  ep: number,
  totalEpisodes: number | null,
  pinned: string | null
): LocalEpisodeFile | undefined {
  for (const release of playOrder(groupReleases(files, totalEpisodes), pinned)) {
    const file = releaseFile(release, ep, totalEpisodes);
    if (file) return file;
  }
  return undefined;
}

/** Episode → the file that plays it (same choice as `pickEpisodeFile`). */
export function episodeFileMap(
  files: LocalEpisodeFile[],
  totalEpisodes: number | null,
  pinned: string | null
): Map<number, LocalEpisodeFile> {
  const map = new Map<number, LocalEpisodeFile>();
  for (const release of playOrder(groupReleases(files, totalEpisodes), pinned)) {
    for (const ep of release.episodes) {
      if (map.has(ep)) continue;
      const file = releaseFile(release, ep, totalEpisodes);
      if (file) map.set(ep, file);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------------------------
// Pinned releases: loaded once, mirrored here so plain helpers (`playLocalEpisode`) can read them
// ---------------------------------------------------------------------------------------------

let pinnedByAnime: Record<string, string> = {};
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((l) => l());

export function loadReleasePreferences(): Promise<void> {
  if (!loading) {
    loading = toraApi
      .getReleasePreferences()
      .then((prefs) => {
        pinnedByAnime = { ...prefs, ...pinnedByAnime };
        notify();
      })
      .catch((e) => {
        log.error("releases", "Failed to load release preferences", e);
        loading = null;
      });
  }
  return loading;
}

/** The anime's pinned release key (after `loadReleasePreferences`). */
export const pinnedRelease = (animeId: number): string | null => pinnedByAnime[String(animeId)] ?? null;

/** Pins a release for the anime, or unpins (`null`: the oldest release plays again). */
export async function setPinnedRelease(animeId: number, key: string | null): Promise<void> {
  const next = { ...pinnedByAnime };
  if (key) next[String(animeId)] = key;
  else delete next[String(animeId)];
  pinnedByAnime = next;
  notify();
  await toraApi.setReleasePreference(animeId, key);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The anime's pinned release key, re-rendering when it changes. */
export function usePinnedRelease(animeId: number | null): string | null {
  useEffect(() => {
    loadReleasePreferences();
  }, []);
  return useSyncExternalStore(subscribe, () => (animeId === null ? null : pinnedRelease(animeId)));
}
