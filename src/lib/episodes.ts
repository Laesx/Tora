// Episode availability helpers: on-disk ranges and the Taiga-style progress bar model.

import { AnimeEntry } from "./types";
import { formatCountdown } from "./format";

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Sorted, unique, positive episode numbers (the backend already sends them sorted & unique). */
function cleanEpisodes(episodes: number[]): number[] {
  let ok = true;
  for (let i = 0; i < episodes.length; i++) {
    if (!(episodes[i] > 0) || (i > 0 && episodes[i] <= episodes[i - 1])) {
      ok = false;
      break;
    }
  }
  if (ok) return episodes;
  return Array.from(new Set(episodes.filter((n) => typeof n === "number" && n > 0))).sort(
    (a, b) => a - b
  );
}

/** Sorted episode numbers as compact ranges: [1, 2, 3, 5] -> ["1–3", "5"]. */
function episodeRanges(episodes: number[]): string[] {
  const sorted = cleanEpisodes(episodes ?? []);
  if (sorted.length === 0) return [];
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i];
    if (curr === prev + 1) {
      prev = curr;
    } else {
      ranges.push(start === prev ? `${start}` : `${start}–${prev}`);
      start = curr;
      prev = curr;
    }
  }
  ranges.push(start === prev ? `${start}` : `${start}–${prev}`);
  return ranges;
}

/**
 * Formats an array of episode numbers into compact ranges (e.g., [1, 2, 3, 5, 8] -> "Ep 1–3, 5, 8").
 */
export function formatEpisodeRanges(episodes: number[]): string {
  const ranges = episodeRanges(episodes);
  return ranges.length > 0 ? `Ep ${ranges.join(", ")}` : "";
}

/**
 * Last episode that has aired, or `null` when unknown. A past `next_airing_at` (data not refreshed
 * since) means that episode has aired too.
 */
export function latestAiredEpisode(anime: AnimeEntry, now = nowSeconds()): number | null {
  if (anime.next_airing_episode) {
    return anime.next_airing_at && anime.next_airing_at <= now
      ? anime.next_airing_episode
      : anime.next_airing_episode - 1;
  }
  if (anime.airing_status === "FINISHED") return anime.episodes;
  if (anime.airing_status === "NOT_YET_RELEASED") return 0;
  return null;
}

/** Taiga's guess for an unknown total while airing: snap to 12 / 26 / 52, else `null`. */
export function estimatedTotal(anime: AnimeEntry, now = nowSeconds()): number | null {
  if ((anime.episodes && anime.episodes > 0) || anime.airing_status === "FINISHED") return null;
  const eps = anime.available_episodes ?? [];
  let maxOnDisk = 0;
  for (const ep of eps) if (ep > maxOnDisk) maxOnDisk = ep;
  const known = Math.max(latestAiredEpisode(anime, now) ?? 0, anime.user_progress, maxOnDisk);
  if (known < 12) return 12;
  if (known < 24) return 26;
  if (known < 50) return 52;
  return null;
}

/** Total for "Ep 5 / 12" counters: `12`, `~12` (estimated) or `?`. */
export function episodeTotalLabel(anime: AnimeEntry): string {
  if (anime.episodes && anime.episodes > 0) return String(anime.episodes);
  const est = estimatedTotal(anime);
  return est ? `~${est}` : "?";
}

/** A contiguous run of episodes in the thin strip: on disk, or aired past the progress but missing. */
export interface StripRun {
  from: number;
  to: number;
  leftPct: number;
  widthPct: number;
  kind: "disk" | "missing";
}

export interface EpisodeBarModel {
  /** Episodes the full bar width stands for */
  scale: number;
  watchedPct: number;
  strip: StripRun[];
  tooltip: string;
}

const MAX_TOOLTIP_RANGES = 8;

function rangesText(episodes: number[]): string | null {
  const ranges = episodeRanges(episodes);
  if (ranges.length === 0) return null;
  const shown = ranges.slice(0, MAX_TOOLTIP_RANGES).join(", ");
  return `Ep ${shown}${ranges.length > MAX_TOOLTIP_RANGES ? ", …" : ""}`;
}

/**
 * Taiga-style bar: watched fill, plus a thin strip of every episode on disk and of aired
 * episodes past the progress that are missing. Nothing is drawn past the last aired episode.
 */
export function episodeBar(anime: AnimeEntry, now = nowSeconds()): EpisodeBarModel {
  const progress = Math.max(0, anime.user_progress);
  const total = anime.episodes && anime.episodes > 0 ? anime.episodes : null;
  const aired = latestAiredEpisode(anime, now);
  const eps = cleanEpisodes(anime.available_episodes ?? []);
  const maxOnDisk = eps.length > 0 ? eps[eps.length - 1] : 0;
  const estimate = estimatedTotal(anime, now);

  // Unknown total: Taiga's estimate, else what is known plus a short tail while it is still airing
  const known = Math.max(progress, aired ?? 0, maxOnDisk, 1);
  const tail = Math.min(12, Math.max(1, Math.ceil(known * 0.1)));
  const scale =
    total ?? estimate ?? (anime.airing_status === "RELEASING" ? known + tail : known);

  const onDisk = new Set(eps);
  const airedLimit = Math.min(aired ?? maxOnDisk, scale);
  const missing: number[] = [];
  for (let ep = progress + 1; ep <= airedLimit; ep++) {
    if (!onDisk.has(ep)) missing.push(ep);
  }

  // Strip runs: disk episodes anywhere, missing ones past the progress (both sorted)
  const marks: { ep: number; kind: StripRun["kind"] }[] = [];
  for (const ep of eps) if (ep <= scale) marks.push({ ep, kind: "disk" });
  for (const ep of missing) marks.push({ ep, kind: "missing" });
  marks.sort((a, b) => a.ep - b.ep);
  const strip: StripRun[] = [];
  for (const m of marks) {
    const last = strip[strip.length - 1];
    if (last && last.kind === m.kind && last.to === m.ep - 1) last.to = m.ep;
    else strip.push({ from: m.ep, to: m.ep, leftPct: 0, widthPct: 0, kind: m.kind });
  }
  for (const r of strip) {
    r.leftPct = ((r.from - 1) / scale) * 100;
    r.widthPct = ((r.to - r.from + 1) / scale) * 100;
  }

  let ready = 0;
  let extra = 0;
  for (const ep of eps) {
    if (ep > progress) ready++;
    if (total && ep > total) extra++;
  }
  // "Ep 6–8": the run on disk starting right after the progress
  const nextRun = strip.find((r) => r.kind === "disk" && r.from <= progress + 1 && r.to > progress);
  const readyText = nextRun
    ? progress + 1 === nextRun.to
      ? `Ep ${nextRun.to}`
      : `Ep ${progress + 1}–${nextRun.to}`
    : null;
  const missingText = rangesText(missing);

  const lines = [
    `Watched ${progress} / ${total ?? (estimate ? `~${estimate} (estimated total)` : "?")}`,
  ];
  if (readyText) lines.push(`Ready to watch: ${readyText}`);
  if (missingText) lines.push(`Missing: ${missingText}`);
  else if (ready > 0) lines.push("All aired episodes are on disk");
  if (anime.next_airing_episode && anime.next_airing_at && anime.next_airing_at > now) {
    const when = new Date(anime.next_airing_at * 1000).toLocaleString(undefined, {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    lines.push(
      `Ep ${anime.next_airing_episode} airs ${when} (in ${formatCountdown(anime.next_airing_at)})`
    );
  } else if (anime.airing_status === "NOT_YET_RELEASED") {
    lines.push("Not yet aired");
  }
  if (extra > 0) lines.push(`${extra} on disk past episode ${total}`);

  return {
    scale,
    watchedPct: (Math.min(progress, scale) / scale) * 100,
    strip,
    tooltip: lines.join("\n"),
  };
}
