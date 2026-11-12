import React from "react";
import { ExternalLink, Star, X } from "lucide-react";
import { AnimeEntry, StudioRef } from "@/lib/types";
import { formatCountdown } from "@/lib/format";
import { getOptimizedCoverUrl } from "@/lib/covers";
import { altTitles, useAnimeTitle, useTitleLanguage } from "@/contexts/titles";
import { anilistAnimeUrl, anilistStudioUrl, formatEnum, formatMinutes, openExternal } from "@/lib/anime";
import { seasonName } from "@/lib/seasons";
import { AiringDot } from "@/components/AiringDot";
import { useToast } from "@/contexts/toast";

/** Banner, cover and titles (both open AniList), badges and the meta line. */
export const DetailHero: React.FC<{
  anime: AnimeEntry;
  /** Animation studios with AniList ids; null while the stored metadata loads */
  studioRefs: StudioRef[] | null;
  onOpenSeason: (season: string, year: number) => void;
  onClose: () => void;
}> = ({ anime, studioRefs, onOpenSeason, onClose }) => {
  const showToast = useToast();
  const titleOf = useAnimeTitle();
  const titleLanguage = useTitleLanguage();
  const handleOpenAniList = () => openExternal(anilistAnimeUrl(anime), showToast);
  const countdown = formatCountdown(anime.next_airing_at);
  const alternatives = altTitles(anime, titleLanguage);

  // Meta line: season (→ Seasons tab) · episodes · length · studios (→ AniList)
  const metaItems: React.ReactNode[] = [];
  if (anime.season && anime.season_year) {
    const season = anime.season;
    const year = anime.season_year;
    metaItems.push(
      <button
        type="button"
        onClick={() => onOpenSeason(season, year)}
        title="Show this season in Seasons"
        className="font-semibold text-accent hover:underline"
      >
        {seasonName(season)} {year}
      </button>
    );
  }
  if (anime.episodes && anime.format !== "MOVIE") {
    metaItems.push(<span>{anime.episodes} eps</span>);
  }
  if (anime.duration) {
    metaItems.push(
      <span>{anime.format === "MOVIE" ? formatMinutes(anime.duration) : `${anime.duration} min/ep`}</span>
    );
  }
  if (studioRefs && studioRefs.length > 0) {
    metaItems.push(
      <span className="flex flex-wrap gap-x-2">
        {studioRefs.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => openExternal(anilistStudioUrl(s.id), showToast)}
            title="Open studio on AniList"
            className="font-semibold text-accent hover:underline"
          >
            {s.name}
          </button>
        ))}
      </span>
    );
  } else if (anime.studios.length > 0) {
    metaItems.push(<span>{anime.studios.join(", ")}</span>);
  }

  return (
    <div className="relative h-48 w-full bg-bg-tertiary shrink-0 overflow-hidden">
      {anime.banner_image || anime.cover_image ? (
        <img
          src={anime.banner_image || getOptimizedCoverUrl(anime.cover_image, "large")}
          alt={titleOf(anime)}
          decoding="async"
          className="w-full h-full object-cover opacity-45 scale-105 blur-[1px]"
        />
      ) : null}
      <div className="absolute inset-0 bg-gradient-to-t from-bg-secondary via-bg-secondary/60 to-transparent" />

      <button
        type="button"
        onClick={onClose}
        className="
          z-30 absolute top-3.5 right-3.5 w-10 h-10
          flex items-center justify-center rounded-xl
          bg-black/65 hover:bg-accent text-white
          border border-white/15 shadow-lg transition cursor-pointer
        "
        title="Close (Esc)"
      >
        <X className="w-5 h-5" />
      </button>

      <div className="absolute bottom-3 left-6 right-16 flex items-end gap-5">
        <button
          type="button"
          onClick={handleOpenAniList}
          title="Open on AniList"
          className="group relative w-24 h-36 shrink-0 rounded-xl overflow-hidden shadow-xl border-2 border-border-subtle bg-bg-tertiary"
        >
          <img
            src={getOptimizedCoverUrl(anime.cover_image, "medium")}
            alt={titleOf(anime)}
            decoding="async"
            className="w-full h-full object-cover"
          />
          <span className="absolute inset-0 bg-black/55 opacity-0 group-hover:opacity-100 transition flex items-center justify-center gap-1 text-white text-[11px] font-semibold">
            <ExternalLink className="w-3.5 h-3.5" />
            AniList
          </span>
          <AiringDot anime={anime} onCover className="absolute top-1.5 left-1.5" />
        </button>
        <div className="flex-1 min-w-0 pb-1">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className="px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider rounded bg-accent text-white">
              {formatEnum(anime.format)}
            </span>
            <span className="px-2 py-0.5 text-[11px] font-medium rounded bg-bg-elevated text-text-secondary border border-border-subtle">
              {formatEnum(anime.airing_status)}
            </span>
            {anime.average_score && (
              <span className="flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold rounded bg-amber-500/20 text-amber-400">
                <Star className="w-3 h-3 fill-amber-400" />
                {anime.average_score}%
              </span>
            )}
            {countdown && anime.next_airing_episode && (
              <span className="px-2 py-0.5 text-[11px] font-medium rounded bg-emerald-500/20 text-emerald-400">
                Ep {anime.next_airing_episode} in {countdown}
              </span>
            )}
          </div>
          <h2 className="text-xl font-bold text-text-primary truncate">
            <button
              type="button"
              onClick={handleOpenAniList}
              title="Open on AniList"
              className="max-w-full truncate text-left hover:text-accent hover:underline transition"
            >
              {titleOf(anime)}
            </button>
          </h2>
          {alternatives.length > 0 && (
            <p className="text-xs text-text-secondary truncate">{alternatives.join(" • ")}</p>
          )}
          {metaItems.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1.5 text-xs text-text-secondary">
              {metaItems.map((item, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <span className="text-text-muted">·</span>}
                  {item}
                </React.Fragment>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
