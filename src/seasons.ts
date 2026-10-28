// Anime season helpers. Seasons follow broadcast quarters (like Taiga):
// Winter = Jan–Mar, Spring = Apr–Jun, Summer = Jul–Sep, Fall = Oct–Dec.

export const SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"] as const;
export type SeasonName = (typeof SEASONS)[number];

export interface SeasonKey {
  season: SeasonName;
  year: number;
}

/** Oldest year offered by the season picker (AniList has little before this). */
export const FIRST_SEASON_YEAR = 1940;

export function currentSeason(date: Date = new Date()): SeasonKey {
  return {
    season: SEASONS[Math.floor(date.getMonth() / 3)],
    year: date.getFullYear(),
  };
}

function seasonOrdinal(key: SeasonKey): number {
  return key.year * 4 + SEASONS.indexOf(key.season);
}

export function shiftSeason(key: SeasonKey, delta: number): SeasonKey {
  const ord = seasonOrdinal(key) + delta;
  return { season: SEASONS[((ord % 4) + 4) % 4], year: Math.floor(ord / 4) };
}

export function compareSeasons(a: SeasonKey, b: SeasonKey): number {
  return seasonOrdinal(a) - seasonOrdinal(b);
}

export function sameSeason(a: SeasonKey, b: SeasonKey): boolean {
  return a.season === b.season && a.year === b.year;
}

export function seasonName(season: SeasonName | string): string {
  return season.charAt(0) + season.slice(1).toLowerCase();
}

export function seasonLabel(key: SeasonKey): string {
  return `${seasonName(key.season)} ${key.year}`;
}

/** Stable string id, e.g. "FALL-2026". */
export function seasonId(key: SeasonKey): string {
  return `${key.season}-${key.year}`;
}
