import type { TimeFormat } from "./types";

/**
 * Locale and clock for every date and time in the UI (Settings → Appearance). The webview's own
 * locale follows the Windows display language, not the regional format, so nothing may rely on it:
 * pass `dateLocale()` to `toLocaleDateString`, use `formatTime` / `formatDateTime` for anything that
 * shows a time, and `DateInput` instead of `<input type="date">`.
 *
 * A plain mirror of the settings, set in App's body like `setCurrentTitleLanguage`, so helpers outside
 * React can use it too. App keys the tab content on the settings, so a change redraws every label.
 */

let systemLocale: string | undefined;
let locale: string | undefined;
let timeFormat: TimeFormat = "auto";
let fieldFormat: DateFieldFormat | null = null;

/** Windows can return names Intl rejects ("es-ES_tradnl"): keep the part before the sort variant. */
function validLocale(tag: string | null | undefined): string | undefined {
  const base = tag?.split("_")[0];
  if (!base) return undefined;
  try {
    return Intl.getCanonicalLocales(base)[0];
  } catch {
    return undefined;
  }
}

export function setDateSettings(setting: string | undefined, system: string | undefined, clock: TimeFormat | undefined) {
  systemLocale = validLocale(system);
  const next = validLocale(setting) ?? systemLocale;
  if (next !== locale) fieldFormat = null;
  locale = next;
  timeFormat = clock ?? "auto";
}

/** The locale for `toLocaleDateString`; `undefined` (the webview's) only until the settings load. */
export const dateLocale = () => locale;

/** The Windows regional locale, for the Auto choice in Settings. */
export const systemDateLocale = () => systemLocale;

/** Empty id = Auto. Named by order rather than by country: the point of these is the format. */
export const DATE_LOCALE_OPTIONS: { id: string; label: string }[] = [
  { id: "", label: "Auto" },
  { id: "en-GB", label: "Day/month/year" },
  { id: "en-US", label: "Month/day/year" },
  { id: "en-CA", label: "Year-month-day" },
];

export const TIME_FORMATS: { id: TimeFormat; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "24h", label: "24h" },
  { id: "12h", label: "12h" },
];

// `hourCycle`, not `hour12`: `hour12: false` shows midnight as "24:07" in en-US.
const withClock = (options?: Intl.DateTimeFormatOptions, clock: TimeFormat = timeFormat): Intl.DateTimeFormatOptions => {
  if (clock === "auto") return options ?? {};
  return { ...options, hourCycle: clock === "24h" ? "h23" : "h12" };
};

export const formatTime = (date: Date, options?: Intl.DateTimeFormatOptions) =>
  date.toLocaleTimeString(locale, withClock(options));

export const formatDateTime = (date: Date, options?: Intl.DateTimeFormatOptions) =>
  date.toLocaleString(locale, withClock(options));

const NUMERIC_DATE: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", year: "numeric" };

function isoToDate(iso: string): Date | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** `2026-11-04` → `04/11/2026` in the chosen format; anything that isn't a full date stays as it is. */
export function formatDate(iso: string): string {
  const date = isoToDate(iso);
  return date ? date.toLocaleDateString(locale, NUMERIC_DATE) : iso;
}

/** Sample of a Settings choice: `04/11/2026 · 4 November` */
export function dateLocaleSample(id: string, now = new Date()): string {
  const tag = validLocale(id) ?? systemLocale;
  return `${now.toLocaleDateString(tag, NUMERIC_DATE)} · ${now.toLocaleDateString(tag, { day: "numeric", month: "long" })}`;
}

/** A date in the user's timezone as `YYYY-MM-DD` (`toISOString` would give the UTC day). */
function localIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const todayIso = () => localIso(new Date());

// ---------------------------------------------------------------------------
// Date text field
// ---------------------------------------------------------------------------

type DatePart = "day" | "month" | "year";

interface DateFieldFormat {
  order: DatePart[];
  separator: string;
}

function dateFieldFormat(): DateFieldFormat {
  if (fieldFormat) return fieldFormat;
  const parts = new Intl.DateTimeFormat(locale, NUMERIC_DATE).formatToParts(new Date(2000, 0, 2));
  const order = parts.flatMap((p) => (p.type === "day" || p.type === "month" || p.type === "year" ? [p.type] : []));
  const separator = parts.find((p) => p.type === "literal")?.value.trim() || "/";
  fieldFormat = { order: order.length === 3 ? order : ["day", "month", "year"], separator };
  return fieldFormat;
}

export function dateFieldPlaceholder(): string {
  const { order, separator } = dateFieldFormat();
  const names: Record<DatePart, string> = { day: "dd", month: "mm", year: "yyyy" };
  return order.map((p) => names[p]).join(separator);
}

/** `2026-11-04` → the text a date field shows */
export function formatDateField(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const values: Record<DatePart, string> = { year: m[1], month: m[2], day: m[3] };
  const { order, separator } = dateFieldFormat();
  return order.map((p) => values[p]).join(separator);
}

/**
 * The text of a date field → `YYYY-MM-DD`, `""` when it's empty, `null` while it isn't a real date.
 * Needs a 4-digit year from 1900 on, so a half-typed year never counts. A pasted `2026-11-04` works in
 * any format.
 */
export function parseDateField(text: string): string | null {
  const fields = text.trim().split(/[/\-.\s]+/).filter(Boolean);
  if (fields.length === 0) return "";
  if (fields.length !== 3 || !fields.every((f) => /^\d+$/.test(f))) return null;
  const order: DatePart[] = fields[0].length === 4 ? ["year", "month", "day"] : dateFieldFormat().order;
  const values = {} as Record<DatePart, string>;
  order.forEach((part, i) => (values[part] = fields[i]));
  if (values.year.length !== 4 || values.month.length > 2 || values.day.length > 2) return null;
  const [year, month, day] = [Number(values.year), Number(values.month), Number(values.day)];
  const date = new Date(year, month - 1, day);
  if (year < 1900 || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return localIso(date);
}
