import type { AnimeEntry } from "./types";

/**
 * In-house fuzzy matcher shared by the watchlist search and the command palette.
 *
 * Text is normalized once at index time (lowercase, diacritics stripped, punctuation collapsed to
 * single spaces). A record matches when either
 *  - the whole query with its spaces removed is an in-order subsequence of one title
 *    ("kusuriya3", "spyfam", "rezero"), or
 *  - every space-separated token matches some field, in any order ("season 2 kusuriya").
 * Queries/tokens of 1–2 characters only match as substrings (word starts score highest). Longer
 * ones match as a subsequence anywhere, scored fzf-style: bonuses for word starts and consecutive
 * characters, penalties for gaps; matches spread too far apart are rejected. A per-record
 * character bitmask rejects most non-matches before any scoring.
 */

const SCORE_MATCH = 16;
const GAP_START = -3;
const GAP_EXTENSION = -1;
const BONUS_BOUNDARY = 8;
const BONUS_CONSECUTIVE = 4;
const BONUS_FIRST_CHAR_MULTIPLIER = 2;
const BONUS_FIELD_PREFIX = 6;
const BONUS_WHOLE_WORD = 4;
/** Fuzzy matches spread wider than this (relative to the token) are noise, not matches */
const MAX_SPREAD_PER_CHAR = 4;
/** Tokens shorter than this only match as substrings */
const FUZZY_MIN_TOKEN = 3;
/** Matches only found in secondary fields (genres, studios, keywords) are scaled down */
const META_WEIGHT = 0.4;

export const NO_MATCH = -Infinity;

const MARKS = /\p{M}/gu;
const NON_ALNUM = /[^\p{L}\p{N}]+/gu;
const ALNUM = /[\p{L}\p{N}]/u;

export function normalizeSearchText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(MARKS, "")
    .toLowerCase()
    .replace(NON_ALNUM, " ")
    .trim();
}

/** Same normalization as `normalizeSearchText`, plus the original index of every output char. */
function normalizeWithMap(original: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  let lastWasSpace = true;
  for (let i = 0; i < original.length; ) {
    const cp = original.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const norm = ch.normalize("NFKD").replace(MARKS, "").toLowerCase();
    for (const c of norm) {
      if (ALNUM.test(c)) {
        text += c;
        for (let k = 0; k < c.length; k++) map.push(i);
        lastWasSpace = false;
      } else if (!lastWasSpace) {
        text += " ";
        map.push(i);
        lastWasSpace = true;
      }
    }
    i += ch.length;
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    map.pop();
  }
  return { text, map };
}

/** 32-bit set of the a–z / 0–9 characters in `s` (digits share 6 bits; collisions only weaken the filter). */
function charMask(s: string): number {
  let mask = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 97 && c <= 122) mask |= 1 << (c - 97);
    else if (c >= 48 && c <= 57) mask |= 1 << (26 + ((c - 48) % 6));
  }
  return mask;
}

const isBoundary = (text: string, i: number) =>
  i === 0 || text.charCodeAt(i - 1) === 32;

/** Scores the greedy alignment of `token` inside `text[start..end]`; optionally collects positions. */
function scoreWindow(
  token: string,
  text: string,
  start: number,
  end: number,
  positions?: number[]
): number {
  let score = 0;
  let p = 0;
  let inGap = false;
  let chunkBonus = 0;
  let prevMatched = false;
  for (let i = start; i <= end && p < token.length; i++) {
    if (text.charCodeAt(i) === token.charCodeAt(p)) {
      score += SCORE_MATCH;
      let bonus = isBoundary(text, i) ? BONUS_BOUNDARY : 0;
      if (prevMatched) {
        bonus = Math.max(bonus, chunkBonus, BONUS_CONSECUTIVE);
      } else {
        chunkBonus = bonus;
      }
      if (p === 0) bonus *= BONUS_FIRST_CHAR_MULTIPLIER;
      score += bonus;
      positions?.push(i);
      p++;
      prevMatched = true;
      inGap = false;
    } else {
      score += inGap ? GAP_EXTENSION : GAP_START;
      inGap = true;
      prevMatched = false;
    }
  }
  if (start === 0) score += BONUS_FIELD_PREFIX;
  if (
    end - start + 1 === token.length &&
    isBoundary(text, start) &&
    (end + 1 === text.length || text.charCodeAt(end + 1) === 32)
  ) {
    score += BONUS_WHOLE_WORD;
  }
  // Tie-break: shorter fields rank higher (at most 2 points)
  return score - Math.min(text.length, 200) / 100;
}

/** Best [start, end] window of `token` in `text`, or null. */
function align(
  token: string,
  text: string,
  fuzzy: boolean
): { start: number; end: number } | null {
  const n = token.length;
  if (n === 0 || n > text.length) return null;

  // Substring: take the first occurrence at a word start, else the first occurrence
  let idx = text.indexOf(token);
  if (idx !== -1) {
    let first = idx;
    while (idx !== -1 && !isBoundary(text, idx)) idx = text.indexOf(token, idx + 1);
    const start = idx !== -1 ? idx : first;
    return { start, end: start + n - 1 };
  }
  if (!fuzzy) return null;

  // Subsequence anywhere in the text. Candidate windows: one starting at every occurrence of the
  // first char that is a word start, plus the tightest window (fzf v1: earliest end, then the
  // latest start for it). The best-scoring window within the spread cap wins.
  const first = token.charCodeAt(0);
  const maxSpread = n * MAX_SPREAD_PER_CHAR;
  let best: { start: number; end: number } | null = null;
  let bestScore = NO_MATCH;
  const consider = (start: number, end: number) => {
    if (end - start + 1 > maxSpread) return;
    const s = scoreWindow(token, text, start, end);
    if (s > bestScore) {
      bestScore = s;
      best = { start, end };
    }
  };
  const endFrom = (start: number) => {
    let p = 1;
    for (let i = start + 1; i < text.length; i++) {
      if (text.charCodeAt(i) === token.charCodeAt(p) && ++p === n) return i;
    }
    return n === 1 ? start : -1;
  };

  const firstAt = text.indexOf(token[0]);
  if (firstAt === -1) return null;
  const tightEnd = endFrom(firstAt);
  if (tightEnd < 0) return null;
  let tightStart = tightEnd;
  for (let i = tightEnd, p = n - 1; i >= 0; i--) {
    if (text.charCodeAt(i) === token.charCodeAt(p) && --p < 0) {
      tightStart = i;
      break;
    }
  }
  consider(tightStart, tightEnd);

  for (let b = firstAt; b < text.length; b++) {
    if (text.charCodeAt(b) !== first || !isBoundary(text, b)) continue;
    const end = endFrom(b);
    // A later start can't complete if this one didn't
    if (end < 0) break;
    consider(b, end);
  }
  return best;
}

/** Score of one normalized token against one normalized field (`NO_MATCH` if absent). */
export function scoreField(token: string, text: string, fuzzy: boolean): number {
  const w = align(token, text, fuzzy);
  return w ? scoreWindow(token, text, w.start, w.end) : NO_MATCH;
}

export interface PreparedQuery {
  tokens: string[];
  mask: number;
  /** Whole normalized query, for the multi-word phrase bonus */
  phrase: string;
  /** Query without spaces, matched as one subsequence (only set for multi-token queries) */
  compact: string | null;
}

export function prepareQuery(query: string): PreparedQuery {
  const phrase = normalizeSearchText(query);
  const tokens = phrase ? phrase.split(" ") : [];
  const compact = tokens.length > 1 ? tokens.join("") : null;
  return { tokens, mask: charMask(phrase), phrase, compact };
}

export interface SearchRecord<T> {
  item: T;
  /** Normalized primary fields first (titles / labels), then secondary ones (genres, keywords) */
  fields: string[];
  primaryCount: number;
  mask: number;
}

export interface SearchHit<T> {
  item: T;
  score: number;
}

type FieldList = (string | null | undefined)[];

const normalizeFields = (values: FieldList, seen: Set<string>) => {
  const out: string[] = [];
  for (const v of values) {
    if (!v) continue;
    const n = normalizeSearchText(v);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
};

export function buildSearchIndex<T>(
  items: T[],
  primary: (item: T) => FieldList,
  secondary?: (item: T) => FieldList
): SearchRecord<T>[] {
  return items.map((item) => {
    const seen = new Set<string>();
    const main = normalizeFields(primary(item), seen);
    const meta = secondary ? normalizeFields(secondary(item), seen) : [];
    const fields = main.concat(meta);
    let mask = 0;
    for (const f of fields) mask |= charMask(f);
    return { item, fields, primaryCount: main.length, mask };
  });
}

/** Records matching every token, best first. Records keep their index order on equal scores. */
export function search<T>(
  index: SearchRecord<T>[],
  query: string | PreparedQuery
): SearchHit<T>[] {
  const q = typeof query === "string" ? prepareQuery(query) : query;
  const hits: SearchHit<T>[] = [];
  if (q.tokens.length === 0) return hits;
  const fuzzy = q.tokens.map((t) => t.length >= FUZZY_MIN_TOKEN);

  const compact =
    q.compact && q.compact.length >= FUZZY_MIN_TOKEN ? q.compact : null;

  for (const rec of index) {
    if ((rec.mask & q.mask) !== q.mask) continue;

    // Whole query as one subsequence of a title ("kusuriya3")
    let compactBest = NO_MATCH;
    if (compact) {
      for (let f = 0; f < rec.primaryCount; f++) {
        const s = scoreField(compact, rec.fields[f], true);
        if (s > compactBest) compactBest = s;
      }
    }

    // Every token somewhere, any order ("season 2 kusuriya")
    let total = 0;
    let matched = true;
    for (let t = 0; t < q.tokens.length; t++) {
      const token = q.tokens[t];
      let best = NO_MATCH;
      for (let f = 0; f < rec.primaryCount; f++) {
        const s = scoreField(token, rec.fields[f], fuzzy[t]);
        if (s > best) best = s;
      }
      if (best === NO_MATCH) {
        for (let f = rec.primaryCount; f < rec.fields.length; f++) {
          const s = scoreField(token, rec.fields[f], false);
          if (s !== NO_MATCH && s * META_WEIGHT > best) best = s * META_WEIGHT;
        }
      }
      if (best === NO_MATCH) {
        matched = false;
        break;
      }
      total += best;
    }
    if (matched && q.tokens.length > 1) {
      for (let f = 0; f < rec.primaryCount; f++) {
        if (rec.fields[f].includes(q.phrase)) {
          total += BONUS_BOUNDARY * q.tokens.length;
          break;
        }
      }
    }
    const score = Math.max(matched ? total : NO_MATCH, compactBest);
    if (score !== NO_MATCH) hits.push({ item: rec.item, score });
  }
  // Array.prototype.sort is stable, so equal scores keep index order
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

/**
 * Character ranges of `original` matched by `query` (for bolding), merged and sorted.
 * Only meant for the handful of rows actually rendered.
 */
export function matchRanges(query: string, original: string): [number, number][] {
  const q = prepareQuery(query);
  if (q.tokens.length === 0 || !original) return [];
  const { text, map } = normalizeWithMap(original);
  const hit = new Set<number>();
  const mark = (token: string, fuzzy: boolean) => {
    const w = align(token, text, fuzzy);
    if (!w) return false;
    const positions: number[] = [];
    scoreWindow(token, text, w.start, w.end, positions);
    for (const p of positions) hit.add(map[p]);
    return true;
  };
  // Same two ways a record can match as in `search`: all tokens, else the compact query
  const allTokens = q.tokens.every((t) => align(t, text, t.length >= FUZZY_MIN_TOKEN));
  if (allTokens || !q.compact || !mark(q.compact, q.compact.length >= FUZZY_MIN_TOKEN)) {
    for (const token of q.tokens) mark(token, token.length >= FUZZY_MIN_TOKEN);
  }
  const sorted = Array.from(hit).sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const i of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else ranges.push([i, i + 1]);
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// Anime list index (shared by the watchlist search and the command palette)
// ---------------------------------------------------------------------------

export type AnimeSearchIndex = SearchRecord<AnimeEntry>[];

export function buildAnimeSearchIndex(list: AnimeEntry[]): AnimeSearchIndex {
  return buildSearchIndex(
    list,
    (a) => [a.title_romaji, a.title_english, a.title_native, ...a.synonyms],
    (a) => [...a.genres, ...a.studios]
  );
}

export const searchAnime = (
  index: AnimeSearchIndex,
  query: string | PreparedQuery
): SearchHit<AnimeEntry>[] => search(index, query);
