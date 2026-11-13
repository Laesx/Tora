import React, { useMemo, useState } from "react";
import { Clock, ExternalLink, Eye, EyeOff, FolderOpen, Magnet, Play, Plus, Star } from "lucide-react";
import { AnimeEntry, MediaMetadata } from "@/lib/types";
import { formatCountdown } from "@/lib/format";
import { getOptimizedCoverUrl } from "@/lib/covers";
import { anilistAnimeUrl, anilistGenreUrl, anilistTagUrl, formatEnum, openAnimeFolder, openExternal } from "@/lib/anime";
import { STATUS_INFO } from "@/lib/status";
import { altTitles, useAnimeTitle, useTitleLanguage } from "@/contexts/titles";
import { torrentSearchFor } from "@/lib/torrents";
import { episodeBar, episodeTotalLabel } from "@/lib/episodes";
import { EpisodeProgressBar } from "@/components/EpisodeProgressBar";
import { useScoreFormat } from "@/contexts/scoreFormat";
import { formatScore, SCORE_SCALES } from "@/lib/scores";
import { AiringDot } from "@/components/AiringDot";
import { useToast } from "@/contexts/toast";
import { useAnimeActions } from "@/contexts/animeActions";

const MAX_TAGS = 12;

const chipClass =
  "px-2 py-0.5 rounded-md bg-bg-tertiary text-text-secondary hover:text-accent hover:bg-accent/10 text-[11px] font-medium transition cursor-pointer";
const secondaryButton =
  "flex items-center gap-1.5 px-3 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated text-text-secondary hover:text-text-primary text-xs font-semibold transition";

export interface AnimeHeroSlots {
  /** Badges before the list status (Now Playing: player, update state, resolution, group) */
  badges?: React.ReactNode;
  /** Replaces the progress line (Now Playing: "Episode N / total") */
  episodeLine?: React.ReactNode;
  /** Extra actions after the default ones */
  actions?: React.ReactNode;
  /** No "Play next" (Now Playing: something is already playing) */
  hidePlayNext?: boolean;
}

/**
 * The anime page's header: a full-width band fading into the page (banner, else the cover blurred), the
 * cover overlapping it, titles (→ AniList), badges, progress, actions, genres and tags (spoilers hidden
 * until asked). Now Playing fills the slots with its playback state.
 */
export const AnimeHero: React.FC<
  {
    anime: AnimeEntry;
    inList: boolean;
    metadata: MediaMetadata | null;
    /** Episode the "Play next" button plays, when it is on disk */
    onPlayNext?: () => void;
  } & AnimeHeroSlots
> = ({ anime, inList, metadata, onPlayNext, badges, episodeLine, actions, hidePlayNext }) => {
  const { searchTorrents, addAnime } = useAnimeActions();
  const showToast = useToast();
  const titleOf = useAnimeTitle();
  const titleLanguage = useTitleLanguage();
  const scoreFormat = useScoreFormat();
  const [showSpoilers, setShowSpoilers] = useState(false);
  const [adding, setAdding] = useState(false);

  const tags = useMemo(
    () =>
      (metadata?.tags ?? [])
        .filter((t) => showSpoilers || !t.is_spoiler)
        .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))
        .slice(0, MAX_TAGS),
    [metadata, showSpoilers]
  );
  const hasSpoilerTags = metadata?.tags.some((t) => t.is_spoiler) ?? false;
  const title = titleOf(anime);
  const subtitles = altTitles(anime, titleLanguage);
  const status = inList ? STATUS_INFO[anime.user_status] : undefined;
  const bar = inList ? episodeBar(anime) : null;
  const totalLabel = episodeTotalLabel(anime);
  const finished = anime.episodes !== null && anime.user_progress >= anime.episodes;
  const openOnAnilist = () => openExternal(anilistAnimeUrl(anime), showToast);

  const add = async (nextStatus: "CURRENT" | "PLANNING") => {
    setAdding(true);
    try {
      await addAnime(anime, nextStatus);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="relative">
      {/* Full-width band that fades into the page: the banner, else the cover blurred, else its color */}
      <div className="absolute inset-x-0 top-0 h-72 overflow-hidden pointer-events-none" aria-hidden>
        {anime.banner_image ? (
          <img src={anime.banner_image} alt="" decoding="async" className="w-full h-full object-cover opacity-60" />
        ) : anime.cover_image ? (
          <img
            src={getOptimizedCoverUrl(anime.cover_image, "medium")}
            alt=""
            decoding="async"
            className="w-full h-full object-cover scale-125 blur-2xl opacity-40"
          />
        ) : anime.cover_color ? (
          <div className="w-full h-full opacity-30" style={{ background: anime.cover_color }} />
        ) : null}
        <div className="absolute inset-0 bg-gradient-to-b from-bg-primary/10 via-bg-primary/60 to-bg-primary" />
        <div className="absolute inset-0 bg-gradient-to-r from-bg-primary/70 via-transparent to-transparent" />
      </div>

      <div className="relative flex flex-col sm:flex-row gap-6 px-6 pt-28">
        <button
          onClick={openOnAnilist}
          title="Open on AniList"
          className="group relative w-40 shrink-0 self-start rounded-xl overflow-hidden border border-border-subtle shadow-2xl"
        >
          <img
            src={getOptimizedCoverUrl(anime.cover_image, "large")}
            alt={title}
            decoding="async"
            className="w-40 aspect-[2/3] object-cover"
          />
          <AiringDot anime={anime} onCover className="absolute top-2 left-2" />
          <span className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition flex items-center justify-center text-white text-xs font-semibold gap-1.5">
            <ExternalLink className="w-4 h-4" />
            AniList
          </span>
        </button>

        <div className="flex-1 min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {badges}
            {status && (
              <span className={`px-2 py-1 rounded-lg text-[11px] font-semibold ${status.badge}`}>{status.shortLabel}</span>
            )}
            <span className="px-2 py-1 rounded-lg bg-bg-tertiary text-text-secondary text-[11px] font-semibold uppercase tracking-wider">
              {formatEnum(anime.format)}
            </span>
            {anime.average_score ? (
              <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-500/15 text-amber-400 text-[11px] font-semibold">
                <Star className="w-3 h-3 fill-current" />
                {anime.average_score}%
              </span>
            ) : null}
          </div>

          <div>
            <h2 className="text-2xl font-extrabold text-text-primary leading-tight">
              <button onClick={openOnAnilist} title="Open on AniList" className="text-left hover:text-accent transition">
                {title}
              </button>
            </h2>
            {subtitles.length > 0 && <div className="text-sm text-text-secondary mt-0.5">{subtitles.join(" · ")}</div>}
          </div>

          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            {episodeLine ??
              (inList ? (
                <span className="text-lg font-bold text-accent">
                  {anime.user_progress}
                  <span className="text-text-muted font-semibold"> / {totalLabel}</span>
                  <span className="text-xs font-medium text-text-muted"> episodes watched</span>
                </span>
              ) : (
                <span className="text-sm text-text-secondary">
                  {anime.episodes ? `${anime.episodes} episodes` : "Episodes unknown"} · {formatEnum(anime.airing_status)}
                </span>
              ))}
            {inList && anime.user_score > 0 && (
              <span className="text-xs text-text-secondary flex items-center gap-1" title="Your score">
                {SCORE_SCALES[scoreFormat].numeric && <Star className="w-3.5 h-3.5 text-amber-400 fill-current" />}
                {formatScore(anime.user_score, scoreFormat)}
              </span>
            )}
            {anime.next_airing_episode && anime.next_airing_at && (
              <span className="text-xs text-emerald-400 font-mono flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" />
                Ep {anime.next_airing_episode} in {formatCountdown(anime.next_airing_at)}
              </span>
            )}
          </div>
          {bar && <EpisodeProgressBar bar={bar} className="max-w-md h-2.5 rounded-full" />}

          <div className="flex flex-wrap gap-2 pt-1">
            {inList && !hidePlayNext && !finished && onPlayNext && (
              <button
                onClick={onPlayNext}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-accent hover:bg-accent-hover text-white text-xs font-bold transition"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                Play episode {anime.user_progress + 1}
              </button>
            )}
            {!inList && (
              <>
                <button
                  onClick={() => add("CURRENT")}
                  disabled={adding}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-accent hover:bg-accent-hover text-white text-xs font-bold transition disabled:opacity-60"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  Add to Watching
                </button>
                <button onClick={() => add("PLANNING")} disabled={adding} className={`${secondaryButton} disabled:opacity-60`}>
                  <Plus className="w-3.5 h-3.5" />
                  Add to Planning
                </button>
              </>
            )}
            {inList && (
              <button onClick={() => openAnimeFolder(anime, showToast)} className={secondaryButton}>
                <FolderOpen className="w-3.5 h-3.5" />
                Open folder
              </button>
            )}
            <button onClick={() => searchTorrents(torrentSearchFor(anime))} className={secondaryButton}>
              <Magnet className="w-3.5 h-3.5" />
              Search torrents
            </button>
            {actions}
          </div>

          {(anime.genres.length > 0 || tags.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              {anime.genres.map((g) => (
                <button
                  key={`g-${g}`}
                  onClick={() => openExternal(anilistGenreUrl(g), showToast)}
                  className="px-2 py-0.5 rounded-md bg-accent/15 text-accent hover:bg-accent/25 text-[11px] font-semibold transition cursor-pointer"
                >
                  {g}
                </button>
              ))}
              {tags.map((t) => (
                <button
                  key={`t-${t.name}`}
                  onClick={() => openExternal(anilistTagUrl(t.name), showToast)}
                  title={t.rank !== null ? `${t.rank}% relevance` : undefined}
                  className={`${chipClass} ${t.is_spoiler ? "text-rose-300" : ""}`}
                >
                  {t.name}
                </button>
              ))}
              {hasSpoilerTags && (
                <button
                  onClick={() => setShowSpoilers((v) => !v)}
                  className="px-2 py-0.5 rounded-md text-[11px] text-text-muted hover:text-text-primary flex items-center gap-1 transition"
                >
                  {showSpoilers ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                  {showSpoilers ? "Hide spoilers" : "Show spoilers"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
