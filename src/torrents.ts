import { AnimeEntry, QueryOp, QueryRow, ReleaseTraits } from "./types";

/** What the Torrents tab should search for, handed over from anywhere in the app. */
export interface TorrentSearchRequest {
  query: string;
  /** List entry the search was started from (its card goes first) */
  animeId: number | null;
}

// "3rd Season", "Season 2", "S2", "Part 2", "Cour 2", "II" … at the end of a title
const SEASON_SUFFIX =
  /[\s:\-–]+(?:\d+(?:st|nd|rd|th)\s+season|season\s+\d+|s\d{1,2}|part\s+\d+|\d+(?:st|nd|rd|th)\s+part|cour\s+\d+|\d+(?:st|nd|rd|th)\s+cour|(?:ii|iii|iv|v|vi|vii|viii|ix|x))\s*$/i;

// The same markers followed by a subtitle: "Season 2: Arise from the Shadow", "II: Isekai Ittara…"
const SEASON_WITH_SUBTITLE =
  /\s+(?:\d+(?:st|nd|rd|th)\s+season|season\s+\d+|s\d{1,2}|(?:ii|iii|iv|v|vi|vii|viii|ix|x))\s*:.*$/i;

/**
 * Release names say "S3", not "3rd Season", and Nyaa matches every word, so torrent searches use the title
 * without its season / part suffix. The matcher then sorts results into the right season's card.
 */
export function stripSeasonSuffix(title: string): string {
  let t = title.trim().replace(SEASON_WITH_SUBTITLE, "");
  for (let i = 0; i < 3; i++) {
    const next = t.replace(SEASON_SUFFIX, "").trim();
    if (next === t || next.length === 0) break;
    t = next;
  }
  return t.replace(/[\s:\-–]+$/, "");
}

/** Anime-level torrent search (always Romaji, like release names). */
export const animeTorrentQuery = (anime: AnimeEntry) => stripSeasonSuffix(anime.title_romaji);

export const torrentSearchFor = (anime: AnimeEntry): TorrentSearchRequest => ({
  query: animeTorrentQuery(anime),
  animeId: anime.id,
});

export type QueryFieldKind = "text" | "enum" | "number" | "bool";

export interface QueryFieldInfo {
  id: string;
  label: string;
  kind: QueryFieldKind;
  options?: { value: string; label: string }[];
  placeholder?: string;
}

const YES_NO = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];

/** Fields of the torrent query language, in form-editor order. Must match `torrents/query.rs`. */
export const QUERY_FIELDS: QueryFieldInfo[] = [
  { id: "text", label: "Title contains", kind: "text", placeholder: "word or phrase" },
  { id: "group", label: "Release group", kind: "text", placeholder: "Judas" },
  { id: "res", label: "Resolution", kind: "number", placeholder: "1080p" },
  {
    id: "codec",
    label: "Video codec",
    kind: "enum",
    options: [
      { value: "hevc", label: "HEVC / x265" },
      { value: "avc", label: "AVC / x264" },
      { value: "av1", label: "AV1" },
    ],
  },
  { id: "bits", label: "Bit depth", kind: "number", placeholder: "10" },
  {
    id: "audio",
    label: "Audio",
    kind: "enum",
    options: [
      { value: "aac", label: "AAC" },
      { value: "flac", label: "FLAC" },
      { value: "opus", label: "Opus" },
      { value: "ac3", label: "AC3" },
      { value: "eac3", label: "E-AC3 / DDP" },
      { value: "dts", label: "DTS" },
      { value: "dual", label: "Dual audio" },
    ],
  },
  {
    id: "source",
    label: "Source",
    kind: "enum",
    options: [
      { value: "web", label: "WEB" },
      { value: "bd", label: "Blu-ray" },
      { value: "dvd", label: "DVD" },
      { value: "tv", label: "TV" },
    ],
  },
  { id: "size", label: "Size", kind: "number", placeholder: "1.5GB" },
  { id: "seeds", label: "Seeders", kind: "number", placeholder: "5" },
  { id: "leech", label: "Leechers", kind: "number", placeholder: "0" },
  { id: "trusted", label: "Trusted uploader", kind: "bool", options: YES_NO },
  { id: "remake", label: "Remake", kind: "bool", options: YES_NO },
  { id: "batch", label: "Batch", kind: "bool", options: YES_NO },
  {
    id: "status",
    label: "List status",
    kind: "enum",
    options: [
      { value: "watching", label: "Watching" },
      { value: "planning", label: "Planning" },
      { value: "completed", label: "Completed" },
      { value: "paused", label: "Paused" },
      { value: "dropped", label: "Dropped" },
      { value: "repeating", label: "Rewatching" },
      { value: "none", label: "Not in list" },
    ],
  },
  { id: "ep", label: "Episode", kind: "number", placeholder: "12" },
  { id: "new", label: "New episode", kind: "bool", options: YES_NO },
  { id: "ondisk", label: "Already on disk", kind: "bool", options: YES_NO },
  { id: "inlist", label: "In my list", kind: "bool", options: YES_NO },
  { id: "anime", label: "Anime title", kind: "text", placeholder: "Frieren" },
  { id: "title", label: "Raw title contains", kind: "text", placeholder: "x265" },
  { id: "feed", label: "Feed name", kind: "text", placeholder: "English" },
  { id: "regex", label: "Title regex", kind: "text", placeholder: "\\bv2\\b" },
];

export const fieldInfo = (id: string) => QUERY_FIELDS.find((f) => f.id === id) ?? QUERY_FIELDS[0];

export const OP_SYMBOLS: Record<QueryOp, string> = { is: ":", gt: ">", ge: ">=", lt: "<", le: "<=" };

/** Quotes a value when the text form needs it (mirrors `quote_value` in query.rs). */
export function quoteValue(value: string): string {
  const needs =
    value === "" ||
    /[\s"|]/.test(value) ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.toLowerCase() === "or";
  return needs ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

/** Form rows → query text (the backend canonicalizes it on save). Rows without a value are skipped. */
export function rowsToQuery(rows: QueryRow[], any: boolean): string {
  const parts = rows
    .filter((r) => r.value.trim() !== "")
    .map((r) => {
      const neg = r.negate ? "-" : "";
      const v = r.value.trim();
      if (r.field === "text") return neg + quoteValue(v);
      if (r.field === "regex") return `${neg}/${v.replace(/\//g, "\\/")}/`;
      const op = fieldInfo(r.field).kind === "number" ? OP_SYMBOLS[r.op] : ":";
      return `${neg}${r.field}${op}${quoteValue(v)}`;
    });
  return parts.join(any ? " OR " : " ");
}

/** Query text matching one release group. */
export const groupQuery = (group: string) => `group:${quoteValue(group)}`;

/** `group:X` → `X` (for tier labels); anything else unchanged. */
export function tierLabel(query: string): string {
  const m = /^group:(?:"((?:[^"\\]|\\.)*)"|(\S+))$/i.exec(query.trim());
  if (!m) return query;
  return (m[1] ?? m[2]).replace(/\\(.)/g, "$1");
}

export function episodeLabel(t: Pick<ReleaseTraits, "episode" | "episode_end" | "batch">): string {
  if (t.episode != null && t.episode_end != null) {
    return `${String(t.episode).padStart(2, "0")}–${String(t.episode_end).padStart(2, "0")}`;
  }
  if (t.episode != null) return `Ep ${String(t.episode).padStart(2, "0")}`;
  return t.batch ? "Batch" : "—";
}

/** "5m", "3h", "2d" since a unix timestamp. */
export function ageLabel(unix: number | null, now = Date.now() / 1000): string {
  if (!unix) return "";
  const s = Math.max(0, now - unix);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d`;
  return `${Math.round(s / (86400 * 30))}mo`;
}

/** Placeholder in search feed URLs (any case), replaced by the anime's title. */
export const TITLE_PLACEHOLDER = "%title%";

export const hasTitlePlaceholder = (url: string) => url.toLowerCase().includes(TITLE_PLACEHOLDER);

/** Fills a search feed template like the backend's `search_url`. */
export const fillSearchTemplate = (template: string, query: string) =>
  template.replace(/%title%/gi, encodeURIComponent(query.trim()));

/** Nyaa RSS URL from a query, category and uploader filter (the "Build Nyaa URL" helper). */
export function nyaaUrl(query: string, category: string, filter: number, search = false): string {
  let url = `https://nyaa.si/?page=rss&c=${encodeURIComponent(category || "1_2")}&f=${Math.min(2, Math.max(0, filter))}`;
  const q = query.trim();
  if (search) url += `&q=${TITLE_PLACEHOLDER}${q ? encodeURIComponent(` ${q}`) : ""}`;
  else if (q) url += `&q=${encodeURIComponent(q)}`;
  return url;
}

/** Characters shown decoded like a browser's address bar; the backend's `normalize_url` encodes the same set. */
const DISPLAY_DECODED = ' "<>`{}|\\^[]';

/** UTF-8 sequence length for a lead byte (0 = not a lead byte). */
const utf8Length = (b: number) => (b >= 0xc2 && b < 0xe0 ? 2 : b >= 0xe0 && b < 0xf0 ? 3 : b >= 0xf0 && b < 0xf5 ? 4 : 0);

/**
 * A stored (percent-encoded) feed URL as a browser shows it: `…&q=Erai+1080p%7CJudas` → `…&q=Erai+1080p|Judas`.
 * Only `DISPLAY_DECODED` and valid UTF-8 (non-ASCII) escapes are decoded, so `%26`, `%3D`, `%25`, `+` keep their
 * meaning and saving the shown text gives the same URL back.
 */
export function displayUrl(url: string): string {
  // The closing `%` of `%title%` is never the start of an escape (`%title%20` = the title, then "20")
  return url.replace(/(?<!%title)(?:%[0-9A-Fa-f]{2})+/gi, (run) => {
    const bytes = run.match(/%[0-9A-Fa-f]{2}/g)!.map((h) => parseInt(h.slice(1), 16));
    let out = "";
    let i = 0;
    while (i < bytes.length) {
      const b = bytes[i];
      if (b < 0x80) {
        const ch = String.fromCharCode(b);
        out += DISPLAY_DECODED.includes(ch) ? ch : run.slice(i * 3, i * 3 + 3);
        i += 1;
        continue;
      }
      const len = utf8Length(b);
      if (len && i + len <= bytes.length && bytes.slice(i + 1, i + len).every((c) => c >= 0x80 && c < 0xc0)) {
        try {
          out += new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes.slice(i, i + len)));
          i += len;
          continue;
        } catch {
          // invalid sequence (overlong / surrogate): keep it encoded
        }
      }
      out += run.slice(i * 3, i * 3 + 3);
      i += 1;
    }
    return out;
  });
}

/** `list` with the item at `from` moved to `to` (unchanged when `to` is out of range). */
export const move = <T,>(list: T[], from: number, to: number): T[] => {
  if (to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
};

/** Host of a URL (`subsplease.org`), for default feed names. */
export function urlHost(url: string): string {
  try {
    return new URL(url.trim()).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Nyaa categories offered for feeds. */
export const NYAA_CATEGORIES = [
  { value: "1_0", label: "Anime — all" },
  { value: "1_2", label: "Anime — English-translated" },
  { value: "1_3", label: "Anime — Non-English-translated" },
  { value: "1_4", label: "Anime — Raw" },
  { value: "1_1", label: "Anime — Music video" },
];

export const NYAA_FILTERS = [
  { value: 0, label: "No filter" },
  { value: 1, label: "No remakes" },
  { value: 2, label: "Trusted only" },
];
