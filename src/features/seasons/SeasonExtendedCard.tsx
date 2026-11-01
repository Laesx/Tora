import React from "react";
import { Clock, CornerLeftUp, Eye, EyeOff, Play, Plus, Star } from "lucide-react";
import { AnimeEntry, SeasonalAnime } from "@/lib/types";
import { anilistStudioUrl, formatEnum, formatFuzzyDate, openExternal } from "@/lib/anime";
import { getOptimizedCoverUrl } from "@/lib/covers";
import { formatCountdown } from "@/lib/format";
import { STATUS_INFO } from "@/lib/status";
import { secondaryTitles, useAnimeTitle, useTitleLanguage } from "@/contexts/titles";
import { useToast } from "@/contexts/toast";
import { useAnimeActions } from "@/contexts/animeActions";
import { AiringDot } from "@/components/AiringDot";
import { relevantTags, TagFilterState } from "./tagFilters";

/** Fixed so the virtualized list knows its rows; nothing below may wrap outside its clamp */
export const EXTENDED_CARD_HEIGHT = 304;

/** Outlined so facts don't read as the filled genre / tag chips, which are clickable */
const FACT_PILL =
  "h-[18px] px-1.5 rounded border border-border-subtle text-[10px] leading-4 font-medium text-text-secondary whitespace-nowrap";

const ACTION_BUTTON =
  "h-6 px-2 rounded-lg text-[10px] font-medium flex items-center gap-1 bg-bg-tertiary hover:bg-bg-elevated text-text-secondary hover:text-text-primary transition cursor-pointer";

export const tagChipClass = (state: TagFilterState, base: string) =>
  state === "include"
    ? "bg-emerald-500/20 text-emerald-400"
    : state === "exclude"
      ? "bg-rose-500/20 text-rose-400 line-through"
      : base;

interface SeasonExtendedCardProps {
  anime: SeasonalAnime;
  listEntry?: AnimeEntry;
  listById: Map<number, AnimeEntry>;
  selected: boolean;
  notInterested: boolean;
  tagState: (name: string) => TagFilterState;
  onCycleTag: (name: string) => void;
  onClick: (anime: AnimeEntry, e: React.MouseEvent) => void;
  onDoubleClick: (anime: AnimeEntry, e: React.MouseEvent) => void;
  onContextMenu: (anime: AnimeEntry, e: React.MouseEvent) => void;
  onAdd: (anime: AnimeEntry, status: "CURRENT" | "PLANNING") => void;
  onSetNotInterested: (targets: AnimeEntry[], hidden: boolean) => void;
}

/** One anime of the Seasons extended view: enough to decide whether to watch it without opening it. */
export const SeasonExtendedCard: React.FC<SeasonExtendedCardProps> = ({
  anime,
  listEntry,
  listById,
  selected,
  notInterested,
  tagState,
  onCycleTag,
  onClick,
  onDoubleClick,
  onContextMenu,
  onAdd,
  onSetNotInterested,
}) => {
  const showToast = useToast();
  const { openAnime } = useAnimeActions();
  const titleOf = useAnimeTitle();
  const titleLanguage = useTitleLanguage();
  const meta = anime.metadata;

  const status = listEntry ? STATUS_INFO[listEntry.user_status] : null;
  const countdown = formatCountdown(anime.next_airing_at);
  const score = anime.average_score ?? meta.mean_score;

  const startDate = formatFuzzyDate(anime.start_date);
  const animationStudios = meta.studios.filter((s) => s.is_animation_studio);
  const studioNames = animationStudios.length > 0 ? animationStudios.map((s) => s.name) : anime.studios;

  // A sequel of something on the list says more than one of something that isn't
  const prequel = meta.prequels?.find((p) => listById.has(p.id)) ?? meta.prequels?.[0];
  const prequelEntry = prequel ? listById.get(prequel.id) : undefined;
  const prequelStatus = prequelEntry ? STATUS_INFO[prequelEntry.user_status] : null;

  const openPrequel = () => {
    if (prequelEntry) openAnime(prequelEntry);
    else if (prequel) void openExternal(`https://anilist.co/anime/${prequel.id}`, showToast);
  };

  const genres = new Set(anime.genres);
  const tags = relevantTags(anime);

  return (
    <div
      onClick={(e) => onClick(anime, e)}
      onDoubleClick={(e) => onDoubleClick(anime, e)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(anime, e);
      }}
      style={{ height: EXTENDED_CARD_HEIGHT }}
      className={`group rounded-xl overflow-hidden flex transition shadow-sm cursor-pointer ${selected
        ? "bg-accent/10 border border-accent ring-2 ring-accent/40"
        : "bg-bg-primary border border-border-subtle hover:border-accent/60"
        } ${notInterested ? "opacity-50 hover:opacity-100" : ""}`}
    >
      <div className="relative w-40 shrink-0 bg-bg-tertiary overflow-hidden">
        <img
          src={getOptimizedCoverUrl(anime.cover_image, "large")}
          alt={titleOf(anime)}
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover"
        />
        <span className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-black/75 text-white text-[10px] font-semibold flex items-center gap-1.5">
          <AiringDot anime={anime} size="sm" />
          {anime.format.replace(/_/g, " ")} • {anime.episodes ?? "?"} eps
        </span>
        <div className="absolute bottom-2 left-2 right-2 flex flex-col items-start gap-1">
          {status && listEntry && (
            <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold shadow ${status.badge}`}>
              {status.shortLabel}
              {listEntry.user_status !== "PLANNING" &&
                ` • ${listEntry.user_progress}/${listEntry.episodes ?? "?"}`}
            </span>
          )}
          {countdown && anime.next_airing_episode && (
            <span className="px-2 py-0.5 rounded-md bg-black/75 text-emerald-400 text-[10px] font-mono font-semibold flex items-center gap-1">
              <Clock className="w-3 h-3" />
              Ep {anime.next_airing_episode} in {countdown}
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0 p-3 flex flex-col gap-1">
        {/* Only the synopsis may give up height: `truncate` rows would otherwise shrink to nothing */}
        <h3 className="shrink-0 text-sm font-bold text-text-primary truncate" title={titleOf(anime)}>
          {titleOf(anime)}
        </h3>

        {secondaryTitles(anime, titleLanguage).length > 0 && (
          <p className="shrink-0 text-[11px] leading-4 text-text-muted truncate">
            {secondaryTitles(anime, titleLanguage).join(" • ")}
          </p>
        )}

        <div className="shrink-0 flex items-center gap-1 min-w-0">
          {score ? (
            <span className={`${FACT_PILL} shrink-0 flex items-center gap-1 !text-amber-400 font-bold`}>
              <Star className="w-2.5 h-2.5 fill-amber-400" />
              {score}%
            </span>
          ) : null}
          {anime.source_material && (
            <span className={`${FACT_PILL} shrink-0`}>{formatEnum(anime.source_material)}</span>
          )}
          {startDate && <span className={`${FACT_PILL} shrink-0`}>{startDate}</span>}
          {studioNames.length > 0 && (
            <span className={`${FACT_PILL} min-w-0 truncate`} title={studioNames.join(", ")}>
              {animationStudios.length > 0
                ? animationStudios.map((s, i) => (
                  <React.Fragment key={s.id}>
                    {i > 0 && ", "}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void openExternal(anilistStudioUrl(s.id), showToast);
                      }}
                      onDoubleClick={(e) => e.stopPropagation()}
                      title="Open studio on AniList"
                      className="text-accent hover:underline cursor-pointer"
                    >
                      {s.name}
                    </button>
                  </React.Fragment>
                ))
                : studioNames.join(", ")}
            </span>
          )}
        </div>

        {prequel && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              openPrequel();
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            title={prequelEntry ? "Open the prequel" : "Open the prequel on AniList"}
            className="shrink-0 h-[18px] flex items-center gap-1.5 min-w-0 text-left text-[11px] text-text-secondary hover:text-text-primary transition cursor-pointer"
          >
            <CornerLeftUp className="w-3 h-3 shrink-0 text-text-muted" />
            <span className="truncate">Sequel to {titleOf(prequel)}</span>
            {prequelStatus ? (
              <span className={`shrink-0 px-1.5 rounded text-[10px] font-bold ${prequelStatus.badge}`}>
                {prequelStatus.shortLabel}
              </span>
            ) : (
              <span className="shrink-0 px-1.5 rounded text-[10px] font-semibold bg-bg-tertiary text-text-muted">
                Not on your list
              </span>
            )}
          </button>
        )}

        <p
          className={`text-xs leading-[18px] text-text-secondary whitespace-pre-line ${prequel ? "line-clamp-6" : "line-clamp-[7]"}`}
        >
          {/* Blank lines between paragraphs would use up the clamped lines */}
          {anime.synopsis.replace(/\s*\n\s*/g, "\n").trim() || "No synopsis available."}
        </p>

        {/* Pinned to the bottom: at most two chip rows, then the actions */}
        <div className="mt-auto shrink-0 space-y-1.5" onDoubleClick={(e) => e.stopPropagation()}>
          <div className="flex flex-wrap gap-1 overflow-hidden max-h-[44px]">
            {[...genres, ...tags.map((t) => t.name).filter((n) => !genres.has(n))].map((name) => (
              <button
                key={name}
                onClick={(e) => {
                  e.stopPropagation();
                  onCycleTag(name);
                }}
                title="Filter the season: show only / hide / off"
                className={`h-5 px-1.5 rounded text-[10px] font-medium transition cursor-pointer ${tagChipClass(
                  tagState(name),
                  genres.has(name)
                    ? "bg-accent/15 text-accent hover:bg-accent/25"
                    : "bg-bg-tertiary text-text-secondary hover:text-text-primary"
                )}`}
              >
                {name}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            {!listEntry && (
              <>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onAdd(anime, "CURRENT");
                  }}
                  className="h-6 px-2 rounded-lg bg-accent hover:bg-accent-hover text-white text-[10px] font-semibold flex items-center gap-1 transition cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                  Watching
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onAdd(anime, "PLANNING");
                  }}
                  className={ACTION_BUTTON}
                >
                  + Plan
                </button>
              </>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              {anime.trailer_url && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void openExternal(anime.trailer_url!, showToast);
                  }}
                  title="Watch the trailer"
                  className={ACTION_BUTTON}
                >
                  <Play className="w-3 h-3" />
                  Trailer
                </button>
              )}
              {!listEntry && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onSetNotInterested([anime], !notInterested);
                  }}
                  title={notInterested ? "Bring it back" : "Hide it from this season (X)"}
                  className={ACTION_BUTTON}
                >
                  {notInterested ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                  {notInterested ? "Undo" : "Not interested"}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
