import { createContext, useCallback, useContext } from "react";
import { TitleLanguage } from "@/lib/types";

// Display titles (Settings → Appearance → Title language). Torrent searches always use Romaji,
// since release names do; everything shown to the user goes through `useAnimeTitle`.

export interface TitledMedia {
  title_romaji: string;
  title_english: string | null;
  title_native: string | null;
}

export const TITLE_LANGUAGES: { id: TitleLanguage; label: string }[] = [
  { id: "romaji", label: "Romaji" },
  { id: "english", label: "English" },
  { id: "native", label: "Native" },
];

/** The title in `lang`, falling back to Romaji when that title is missing. */
export function animeTitle(a: TitledMedia, lang: TitleLanguage): string {
  const pick = lang === "english" ? a.title_english : lang === "native" ? a.title_native : null;
  return pick?.trim() || a.title_romaji;
}

/** The other non-empty titles (distinct from the displayed one), for subtitles. */
export function altTitles(a: TitledMedia, lang: TitleLanguage): string[] {
  const shown = animeTitle(a, lang);
  const out: string[] = [];
  for (const t of [a.title_romaji, a.title_english, a.title_native]) {
    const v = t?.trim();
    if (v && v !== shown && !out.includes(v)) out.push(v);
  }
  return out;
}

export const TitleLanguageContext = createContext<TitleLanguage>("romaji");

// Mirror of the provided language for plain (non-React) helpers that build toasts.
let currentLanguage: TitleLanguage = "romaji";
export const setCurrentTitleLanguage = (lang: TitleLanguage) => {
  currentLanguage = lang;
};
/** Display title outside React (helpers in `nowPlaying.ts` / `animeActions.ts`). */
export const displayTitle = (a: TitledMedia) => animeTitle(a, currentLanguage);

export const useTitleLanguage = () => useContext(TitleLanguageContext);

/** `(anime) => display title` for the current title language. */
export function useAnimeTitle(): (a: TitledMedia) => string {
  const lang = useTitleLanguage();
  return useCallback((a: TitledMedia) => animeTitle(a, lang), [lang]);
}
