// One anime's History timeline: watch-throughs → months → one row per day and source.
import { TimelineEpisode } from "@/lib/types";

/** One row: a day's episodes from one source (AniList, Manual, or a player). */
export interface TimelineDay {
  /** Local midnight of the day, unix seconds */
  day: number;
  source: TimelineEpisode["source"];
  /** "AniList", "Manual update" or the player's name */
  sourceLabel: string;
  /** Oldest first */
  episodes: TimelineEpisode[];
}

export interface TimelineMonth {
  /** "March 2023" */
  label: string;
  days: TimelineDay[];
}

/** First watch, then each rewatch. */
export interface WatchThrough {
  index: number;
  episodes: TimelineEpisode[];
  months: TimelineMonth[];
}

const sourceLabel = (e: TimelineEpisode) =>
  e.source === "anilist" ? "AniList" : e.source === "manual" ? "Manual update" : e.player_name;

const localDay = (ts: number) => {
  const d = new Date(ts * 1000);
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000;
};

/**
 * Splits episodes (oldest first) into watch-throughs: a new one starts at an episode the current one
 * already has, so episodes watched out of order don't start a rewatch.
 */
export function splitWatchThroughs(episodes: TimelineEpisode[]): WatchThrough[] {
  const passes: TimelineEpisode[][] = [];
  let seen = new Set<number>();
  for (const e of episodes) {
    if (passes.length === 0 || seen.has(e.episode)) {
      passes.push([]);
      seen = new Set();
    }
    passes[passes.length - 1].push(e);
    seen.add(e.episode);
  }
  return passes.map((eps, index) => ({ index, episodes: eps, months: groupMonths(eps) }));
}

/** Month groups of day rows; a day's episodes from one source share a row. */
function groupMonths(episodes: TimelineEpisode[]): TimelineMonth[] {
  const months: TimelineMonth[] = [];
  for (const e of episodes) {
    const label = new Date(e.timestamp_unix * 1000).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    let month = months[months.length - 1];
    if (!month || month.label !== label) {
      month = { label, days: [] };
      months.push(month);
    }
    const day = localDay(e.timestamp_unix);
    const src = sourceLabel(e);
    const row = month.days.find((d) => d.day === day && d.sourceLabel === src);
    if (row) row.episodes.push(e);
    else month.days.push({ day, source: e.source, sourceLabel: src, episodes: [e] });
  }
  return months;
}

/** "Ep 4", "Ep 9–12", "Ep 1, 3–5" */
export function episodesLabel(episodes: TimelineEpisode[]): string {
  const nums = [...new Set(episodes.map((e) => e.episode))].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    parts.push(i === j ? String(nums[i]) : `${nums[i]}–${nums[j]}`);
    i = j;
  }
  return `Ep ${parts.join(", ")}`;
}

export function watchThroughLabel(index: number): string {
  return index === 0 ? "First watch" : index === 1 ? "Rewatch" : `Rewatch ${index}`;
}
