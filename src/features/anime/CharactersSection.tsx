import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronUp, RefreshCw, Users } from "lucide-react";
import { CharacterRole, MediaDetails, VoiceActor } from "@/lib/types";
import { openExternal } from "@/lib/anime";
import { usePrefs } from "@/hooks/usePrefs";
import { useToast } from "@/contexts/toast";
import { PageSection } from "./PageSection";
import { useSectionCollapsed } from "./sectionPrefs";

/** Characters shown before "Show all". */
const PREVIEW_COUNT = 9;
/** Card height + row gap: every row of the windowed list is exactly this tall. */
const CARD_HEIGHT = 76;
const ROW_GAP = 8;
const ROW_HEIGHT = CARD_HEIGHT + ROW_GAP;
const EXPANDED_MAX_HEIGHT = 600;
const OVERSCAN_ROWS = 3;
/** Load the next page when the last loaded row is this close to the viewport. */
const LOAD_AHEAD_ROWS = 4;

const ROLE_LABELS: Record<string, string> = { MAIN: "Main", SUPPORTING: "Supporting", BACKGROUND: "Background" };

const PREFS_KEY = "tora.anime.prefs";
const DEFAULT_PREFS = { vaLanguage: "Japanese" };

/** Languages with voice actors in these characters: Japanese first, then by how many characters have one. */
function languagesOf(characters: CharacterRole[]): string[] {
  const counts = new Map<string, number>();
  for (const c of characters) {
    for (const lang of new Set(c.voice_actors.map((v) => v.language))) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => Number(b[0] === "Japanese") - Number(a[0] === "Japanese") || b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([lang]) => lang);
}

/** Columns for a width: cards need ~280 px for a character and a voice actor side by side. */
const columnsFor = (width: number) => (width >= 900 ? 3 : width >= 560 ? 2 : 1);

const Portrait: React.FC<{ src: string | null; alt: string }> = ({ src, alt }) => (
  <div className="w-12 h-full shrink-0 rounded-md overflow-hidden bg-bg-tertiary">
    {src && <img src={src} alt={alt} loading="lazy" decoding="async" className="w-full h-full object-cover" />}
  </div>
);

const CharacterCard: React.FC<{ character: CharacterRole; language: string }> = ({ character, language }) => {
  const showToast = useToast();
  const actors: VoiceActor[] = character.voice_actors.filter((v) => v.language === language);
  const va = actors[0];
  const others = actors.slice(1).map((v) => v.name);
  return (
    <div
      className="flex items-stretch gap-2 p-1.5 rounded-xl border border-border-subtle bg-bg-primary/60 overflow-hidden"
      style={{ height: CARD_HEIGHT }}
    >
      <button
        type="button"
        onClick={() => openExternal(`https://anilist.co/character/${character.id}`, showToast)}
        title={character.name_native ? `${character.name} (${character.name_native})` : character.name}
        className="flex items-stretch gap-2 min-w-0 flex-1 text-left group"
      >
        <Portrait src={character.image} alt={character.name} />
        <span className="min-w-0 flex flex-col justify-between py-0.5">
          <span className="text-xs font-semibold text-text-primary line-clamp-2 leading-snug group-hover:text-accent">
            {character.name}
          </span>
          <span className="text-[10px] text-text-muted truncate">{ROLE_LABELS[character.role] ?? character.role}</span>
        </span>
      </button>
      {va && (
        <button
          type="button"
          onClick={() => openExternal(`https://anilist.co/staff/${va.id}`, showToast)}
          title={[va.name_native ? `${va.name} (${va.name_native})` : va.name, ...others.map((n) => `also ${n}`)].join("\n")}
          className="flex items-stretch gap-2 min-w-0 flex-1 justify-end text-right group"
        >
          <span className="min-w-0 flex flex-col justify-between py-0.5 items-end">
            <span className="text-xs font-medium text-text-secondary line-clamp-2 leading-snug group-hover:text-accent">
              {va.name}
            </span>
            <span className="text-[10px] text-text-muted truncate">
              {va.language}
              {others.length > 0 ? ` · +${others.length}` : ""}
            </span>
          </span>
          <Portrait src={va.image} alt={va.name} />
        </button>
      )}
    </div>
  );
};

/**
 * Characters and their voice actors in one language (a picker of the languages this anime has, remembered
 * on this device). Shows a few; "Show all" opens a windowed list that loads more pages as it nears its end.
 */
export const CharactersSection: React.FC<{
  details: MediaDetails;
  loadingMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  onRefresh: () => void;
}> = ({ details, loadingMore, loading, onLoadMore, onRefresh }) => {
  const [prefs, setPrefs] = usePrefs(PREFS_KEY, DEFAULT_PREFS);
  const [expanded, setExpanded] = useState(false);
  const [width, setWidth] = useState(900);
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const collapsed = useSectionCollapsed("characters");

  const characters = details.characters;
  const languages = useMemo(() => languagesOf(characters), [characters]);
  const language = languages.includes(prefs.vaLanguage) ? prefs.vaLanguage : (languages[0] ?? "Japanese");

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [collapsed]);

  const cols = columnsFor(width);
  const rowCount = Math.ceil(characters.length / cols);
  const height = Math.min(rowCount * ROW_HEIGHT, EXPANDED_MAX_HEIGHT);
  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
  const lastRow = Math.min(rowCount, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN_ROWS);
  const nearEnd = Math.ceil((scrollTop + height) / ROW_HEIGHT) >= rowCount - LOAD_AHEAD_ROWS;

  // Expanded: keep loading while the end of what is loaded is (nearly) in view
  useEffect(() => {
    if (!collapsed && expanded && nearEnd && details.characters_has_more && !loadingMore) onLoadMore();
  }, [collapsed, expanded, nearEnd, details.characters_has_more, loadingMore, onLoadMore]);

  if (characters.length === 0) return null;
  const canExpand = characters.length > PREVIEW_COUNT || details.characters_has_more;

  return (
    <PageSection
      id="characters"
      title={
        <>
          <Users className="w-4 h-4 text-accent" />
          Characters
        </>
      }
      aside={
        <>
          {languages.length > 1 && (
            <select
              value={language}
              onChange={(e) => setPrefs({ vaLanguage: e.target.value })}
              title="Voice actor language"
              className="px-2 py-1 rounded-lg bg-bg-primary border border-border-subtle text-[11px] text-text-primary focus:outline-none focus:border-accent"
            >
              {languages.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={onRefresh}
            disabled={loading}
            title="Fetch characters, staff and recommendations again"
            className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </>
      }
    >
      <div ref={containerRef}>
        {expanded ? (
          <div
            className="overflow-y-auto [overflow-anchor:none]"
            style={{ height }}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          >
            <div className="relative" style={{ height: rowCount * ROW_HEIGHT }}>
              {Array.from({ length: lastRow - firstRow }, (_, i) => firstRow + i).map((row) => (
                <div
                  key={row}
                  className="absolute inset-x-0 grid gap-2"
                  style={{ top: row * ROW_HEIGHT, height: CARD_HEIGHT, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
                >
                  {characters.slice(row * cols, row * cols + cols).map((c) => (
                    <CharacterCard key={c.id} character={c} language={language} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {characters.slice(0, PREVIEW_COUNT).map((c) => (
              <CharacterCard key={c.id} character={c} language={language} />
            ))}
          </div>
        )}
      </div>

      {canExpand && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-text-muted">
            {loadingMore
              ? "Loading more characters…"
              : expanded
                ? `${characters.length}${details.characters_has_more ? "+" : ""} characters`
                : ""}
          </span>
          <button
            onClick={() => {
              setExpanded((v) => !v);
              setScrollTop(0);
            }}
            className="flex items-center gap-1 text-[11px] font-semibold text-accent hover:underline"
          >
            {expanded ? (
              <>
                <ChevronUp className="w-3.5 h-3.5" />
                Show fewer
              </>
            ) : (
              "Show all"
            )}
          </button>
        </div>
      )}
    </PageSection>
  );
};
