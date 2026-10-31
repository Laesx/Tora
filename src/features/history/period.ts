// History periods: a local day, month, season (broadcast quarter), year or a range of months.
import { SEASONS, SeasonName, seasonLabel, shiftSeason } from "@/lib/seasons";
import type { HistoryRow, HistorySource } from "@/lib/types";

/** `month` is 0–11 */
export interface MonthKey {
  year: number;
  month: number;
}

export type HistoryPeriod =
  | { unit: "day"; year: number; month: number; day: number }
  | { unit: "month"; year: number; month: number }
  | { unit: "season"; year: number; season: SeasonName }
  | { unit: "year"; year: number }
  /** Inclusive months, `from` ≤ `to` */
  | { unit: "range"; from: MonthKey; to: MonthKey };

export const monthIndex = (k: MonthKey) => k.year * 12 + k.month;
const fromMonthIndex = (i: number): MonthKey => ({ year: Math.floor(i / 12), month: ((i % 12) + 12) % 12 });

/** "2025-03" for a month, the key `get_history_month_counts` uses */
export const monthId = (k: MonthKey) => `${k.year}-${String(k.month + 1).padStart(2, "0")}`;

export function seasonOfMonth(month: number): SeasonName {
  return SEASONS[Math.floor(month / 3)];
}

/** Months `[start, end)` as month indexes the period covers (a day covers its month). */
export function periodMonths(p: HistoryPeriod): [number, number] {
  switch (p.unit) {
    case "day":
    case "month":
      return [monthIndex(p), monthIndex(p) + 1];
    case "season": {
      const start = p.year * 12 + SEASONS.indexOf(p.season) * 3;
      return [start, start + 3];
    }
    case "year":
      return [p.year * 12, p.year * 12 + 12];
    case "range":
      return [monthIndex(p.from), monthIndex(p.to) + 1];
  }
}

const monthStart = (i: number) => {
  const k = fromMonthIndex(i);
  return new Date(k.year, k.month, 1);
};

/** `[from, to)` in unix seconds, local time. */
export function periodBounds(p: HistoryPeriod): [number, number] {
  if (p.unit === "day") {
    return [new Date(p.year, p.month, p.day).getTime() / 1000, new Date(p.year, p.month, p.day + 1).getTime() / 1000];
  }
  const [start, end] = periodMonths(p);
  return [monthStart(start).getTime() / 1000, monthStart(end).getTime() / 1000];
}

/** The same kind of period `delta` steps away (a range moves by its own length). */
export function shiftPeriod(p: HistoryPeriod, delta: number): HistoryPeriod {
  switch (p.unit) {
    case "day": {
      const d = new Date(p.year, p.month, p.day + delta);
      return { unit: "day", year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
    }
    case "month":
      return { unit: "month", ...fromMonthIndex(monthIndex(p) + delta) };
    case "season":
      return { unit: "season", ...shiftSeason(p, delta) };
    case "year":
      return { unit: "year", year: p.year + delta };
    case "range": {
      const len = monthIndex(p.to) - monthIndex(p.from) + 1;
      return {
        unit: "range",
        from: fromMonthIndex(monthIndex(p.from) + delta * len),
        to: fromMonthIndex(monthIndex(p.to) + delta * len),
      };
    }
  }
}

/** The period starts after now (nothing can be in it yet). */
export function periodIsFuture(p: HistoryPeriod, now = Date.now() / 1000): boolean {
  return periodBounds(p)[0] > now;
}

/** Months `a` and `b` in either order; one month when they're the same. */
export function monthRange(a: MonthKey, b: MonthKey): HistoryPeriod {
  if (monthIndex(a) === monthIndex(b)) return { unit: "month", ...a };
  const [from, to] = monthIndex(a) < monthIndex(b) ? [a, b] : [b, a];
  return { unit: "range", from, to };
}

const monthName = (k: MonthKey, month: "short" | "long", withYear = true) =>
  new Date(k.year, k.month, 1).toLocaleDateString(undefined, withYear ? { month, year: "numeric" } : { month });

export function periodLabel(p: HistoryPeriod): string {
  switch (p.unit) {
    case "day":
      return new Date(p.year, p.month, p.day).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    case "month":
      return monthName(p, "long");
    case "season":
      return seasonLabel(p);
    case "year":
      return String(p.year);
    case "range":
      return p.from.year === p.to.year
        ? `${monthName(p.from, "short", false)} – ${monthName(p.to, "short")}`
        : `${monthName(p.from, "short")} – ${monthName(p.to, "short")}`;
  }
}

/**
 * Open History on a period (from Stats), or restore it (Back: search, anime timeline and the rows it had
 * loaded); `nonce` makes a repeat of the same request apply again.
 */
export interface HistoryRequest {
  period: HistoryPeriod | null;
  source: HistorySource;
  search?: string;
  anime?: { id: number; title: string } | null;
  cache?: { rows: HistoryRow[]; hasMore: boolean };
  nonce: number;
}
