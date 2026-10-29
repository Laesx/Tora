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
 * characters, penalties for gaps; matches spread too far apart are rejected. A gap may skip
 * letters inside a word, but a gap that crosses a space must land on a word start ("spyfam" →
 * "spy x family", but not "house" → "t(h)at dev(ou)r(s) th(e)"). A per-record
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

/** Scores one alignment (`pos` = matched index of every token char, ascending). */
function scoreAlignment(token: string, text: string, pos: number[]): number {
  let score = 0;
  let chunkBonus = 0;
  for (let k = 0; k < pos.length; k++) {
    const i = pos[k];
    score += SCORE_MATCH;
    let bonus = isBoundary(text, i) ? BONUS_BOUNDARY : 0;
    if (k > 0 && pos[k - 1] === i - 1) {
      bonus = Math.max(bonus, chunkBonus, BONUS_CONSECUTIVE);
    } else {
      chunkBonus = bonus;
      if (k > 0) score += GAP_START + (i - pos[k - 1] - 2) * GAP_EXTENSION;
    }
    if (k === 0) bonus *= BONUS_FIRST_CHAR_MULTIPLIER;
    score += bonus;
  }
  const start = pos[0];
  const end = pos[pos.length - 1];
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

/** Fuzzy DP rows, reused across calls (index p * text.length + i) */
let endAt = new Int32Array(0);
let nextAt = new Int32Array(0);

/**
 * Best alignment of `token` in `text` (matched positions), or null.
 *
 * Fuzzy rule: letters inside a word may be skipped, but a gap that crosses a space must land on a
 * word start. For every possible start the DP finds the earliest end that keeps to the rule
 * (scanning right to left, one row per token char); the best-scoring start within the spread cap
 * wins.
 */
function align(token: string, text: string, fuzzy: boolean): number[] | null {
  const n = token.length;
  const len = text.length;
  if (n === 0 || n > len) return null;

  // Substring: take the first occurrence at a word start, else the first occurrence
  let idx = text.indexOf(token);
  if (idx !== -1) {
    const first = idx;
    while (idx !== -1 && !isBoundary(text, idx)) idx = text.indexOf(token, idx + 1);
    const start = idx !== -1 ? idx : first;
    return Array.from({ length: n }, (_, k) => start + k);
  }
  if (!fuzzy) return null;

  // Cheap reject: not even a plain subsequence
  for (let i = 0, p = 0; ; i++) {
    if (i === len) return null;
    if (text.charCodeAt(i) === token.charCodeAt(p) && ++p === n) break;
  }

  if (endAt.length < n * len) {
    endAt = new Int32Array(n * len * 2);
    nextAt = new Int32Array(n * len * 2);
  }
  for (let p = n - 1; p >= 0; p--) {
    const row = p * len;
    const nextRow = row + len;
    const ch = token.charCodeAt(p);
    // Best continuation (earliest end) among row p + 1 at j > i: in i's word, or at any word start
    let wordEnd = -1, wordAt = -1, startEnd = -1, startAt = -1;
    for (let i = len - 1; i >= 0; i--) {
      const c = text.charCodeAt(i);
      if (c === 32) {
        wordEnd = -1;
        endAt[row + i] = -1;
        continue;
      }
      let e = -1, at = -1;
      if (c === ch) {
        if (p === n - 1) {
          e = i;
        } else if (wordEnd !== -1 && (startEnd === -1 || wordEnd <= startEnd)) {
          e = wordEnd;
          at = wordAt;
        } else if (startEnd !== -1) {
          e = startEnd;
          at = startAt;
        }
      }
      endAt[row + i] = e;
      nextAt[row + i] = at;
      if (p < n - 1) {
        const ne = endAt[nextRow + i];
        if (ne !== -1) {
          if (wordEnd === -1 || ne <= wordEnd) {
            wordEnd = ne;
            wordAt = i;
          }
          if (isBoundary(text, i) && (startEnd === -1 || ne <= startEnd)) {
            startEnd = ne;
            startAt = i;
          }
        }
      }
    }
  }

  const maxSpread = n * MAX_SPREAD_PER_CHAR;
  let best: number[] | null = null;
  let bestScore = NO_MATCH;
  for (let s = 0; s < len; s++) {
    const e = endAt[s];
    if (e === -1 || e - s + 1 > maxSpread) continue;
    const pos = [s];
    for (let p = 0, i = s; p < n - 1; p++) pos.push((i = nextAt[p * len + i]));
    const score = scoreAlignment(token, text, pos);
    if (score > bestScore) {
      bestScore = score;
      best = pos;
    }
  }
  return best;
}

/** Score of one normalized token against one normalized field (`NO_MATCH` if absent). */
export function scoreField(token: string, text: string, fuzzy: boolean): number {
  const pos = align(token, text, fuzzy);
  return pos ? scoreAlignment(token, text, pos) : NO_MATCH;
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
    const pos = align(token, text, fuzzy);
    if (!pos) return false;
    for (const p of pos) hit.add(map[p]);
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
