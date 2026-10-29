// Airing schedule helpers. Weeks are calendar weeks, Monday 00:00 to the next Monday 00:00, in local time.

import { AnimeEntry } from "@/lib/types";

/** Monday 00:00 (local) of the week containing `date`. */
export function weekStart(date: Date = new Date()): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  // getDay(): 0 = Sunday … 6 = Saturday
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

/** `start` moved by `weeks` (DST-safe: shifts calendar days, not seconds). */
export function shiftWeek(start: Date, weeks: number): Date {
  const d = new Date(start);
  d.setDate(d.getDate() + weeks * 7);
  return d;
}

/** The 7 local midnights of the week starting at `start`. */
export function weekDays(start: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });
}

/** `[from, to)` unix seconds of the week starting at `start`. */
export function weekBounds(start: Date): { from: number; to: number } {
  return {
    from: Math.floor(start.getTime() / 1000),
    to: Math.floor(shiftWeek(start, 1).getTime() / 1000),
  };
}

/** Local calendar day id, e.g. "2026-10-28". */
export function dayKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

export function sameDay(a: Date, b: Date): boolean {
  return dayKey(a) === dayKey(b);
}

/** Column header parts, e.g. { weekday: "Wed", date: "Oct 28" }. */
export function formatDayHeader(date: Date): { weekday: string; date: string } {
  return {
    weekday: date.toLocaleDateString(undefined, { weekday: "short" }),
    date: date.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
  };
}

/** Local time of day in the locale's 12/24h format, e.g. "4:30 PM". */
export function formatSlotTime(unix: number): string {
  return new Date(unix * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** "Oct 26 – Nov 1" (with the year when the week isn't in the current one). */
export function weekLabel(start: Date): string {
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const showYear = start.getFullYear() !== new Date().getFullYear() || end.getFullYear() !== start.getFullYear();
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const fmt = (d: Date) => d.toLocaleDateString(undefined, showYear ? { ...opts, year: "numeric" } : opts);
  return `${fmt(start)} – ${fmt(end)}`;
}

/** Local UTC offset label, e.g. "GMT+1" or "GMT+5:30". */
export function utcOffsetLabel(date: Date = new Date()): string {
  const total = -date.getTimezoneOffset();
  const sign = total >= 0 ? "+" : "-";
  const h = Math.floor(Math.abs(total) / 60);
  const m = Math.abs(total) % 60;
  return `GMT${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

const COUNTRY_LABELS: Record<string, string> = {
  JP: "Japan",
  CN: "China",
  KR: "South Korea",
  TW: "Taiwan",
};

/** `CN` → `China`; unknown codes are shown as-is. */
export function countryLabel(code: string): string {
  return COUNTRY_LABELS[code] ?? code;
}

/** A list anime that usually airs in the viewed week but has no episode in it. */
export interface InferredBreak {
  entry: AnimeEntry;
  /** Where the episode would have aired (unix seconds), at its usual weekday and time */
  expectedAt: number;
  nextEpisode: number;
  nextAt: number;
}

/**
 * Releasing list anime (not Dropped) whose next episode airs after the week `[from, to)` while
 * their weekly slot falls inside it and they have no airing in it (`scheduledIds`). The slot is
 * found by stepping `next_airing_at` back whole local weeks (wall-clock time survives DST); the
 * episode that would air there must be ≥ 1, so shows that haven't started yet aren't flagged.
 * Entries with a stale (past) `next_airing_at` are skipped.
 */
export function detectBreaks(
  entries: AnimeEntry[],
  scheduledIds: Set<number>,
  from: number,
  to: number,
  now: number
): InferredBreak[] {
  const out: InferredBreak[] = [];
  for (const entry of entries) {
    const nextAt = entry.next_airing_at;
    const nextEpisode = entry.next_airing_episode;
    if (!nextAt || !nextEpisode) continue;
    if (entry.airing_status !== "RELEASING" || entry.user_status === "DROPPED") continue;
    if (nextAt <= now || nextAt < to || scheduledIds.has(entry.id)) continue;
    const slot = new Date(nextAt * 1000);
    let weeksBack = 0;
    while (slot.getTime() / 1000 >= to) {
      slot.setDate(slot.getDate() - 7);
      weeksBack++;
    }
    const expectedAt = Math.floor(slot.getTime() / 1000);
    if (expectedAt < from || nextEpisode - weeksBack < 1) continue;
    out.push({ entry, expectedAt, nextEpisode, nextAt });
  }
  return out;
}
