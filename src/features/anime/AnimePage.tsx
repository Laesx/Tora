import React, { useEffect, useMemo, useState } from "react";
import { ListChecks } from "lucide-react";
import { AnimeEntry, SeasonalAnime } from "@/lib/types";
import { toraApi } from "@/lib/api";
import { log } from "@/lib/log";
import { torrentSearchFor } from "@/lib/torrents";
import { pickEpisodeFile, usePinnedRelease } from "@/lib/releases";
import { useToast } from "@/contexts/toast";
import { useAnimeActions } from "@/contexts/animeActions";
import { useCustomLists } from "@/contexts/customLists";
import { CustomListsPanel } from "@/components/CustomListsPanel";
import { useEntryEditor } from "@/features/detail/useEntryEditor";
import { UserStatePanel } from "@/features/detail/UserStatePanel";
import { EpisodesPanel } from "@/features/detail/EpisodesPanel";
import { RelationsPanel, hasVisibleRelations } from "@/features/detail/RelationsPanel";
import { EntrySettings } from "@/features/detail/EntrySettings";
import { AnimeHero, AnimeHeroSlots } from "./AnimeHero";
import { InfoPanel } from "./InfoPanel";
import { PageSection } from "./PageSection";
import { useMediaDetails } from "./useMediaDetails";
import { CharactersSection } from "./CharactersSection";
import { StaffSection } from "./StaffSection";
import { RecommendationsSection } from "./RecommendationsSection";
import { HistorySection } from "./HistorySection";
import { FollowingSection } from "./FollowingSection";

/** How the page's edits reach App's list (the drawer gets the same from App as props). */
export interface EntryCallbacks {
  onUpdated: (updated: AnimeEntry) => void;
  /** A debounced ± step saved after the page closed or switched anime: update the list only */
  onSavedInBackground?: (updated: AnimeEntry) => void;
  onDeleted: (animeId: number) => void;
}

export interface AnimePageProps extends AnimeHeroSlots {
  anime: AnimeEntry;
  inList: boolean;
  /** The user's list by id (relations and recommendations show list state) */
  listById: Map<number, AnimeEntry>;
  onOpenSeason: (season: string, year: number) => void;
  callbacks: EntryCallbacks;
  /** Highlighted in the episode grid (Now Playing) */
  playingEpisode?: number | null;
  /** Right under the hero (Now Playing: the link panel) */
  belowHero?: React.ReactNode;
  /** Last line of the page (Now Playing: the player's window title) */
  footer?: React.ReactNode;
}

/**
 * Everything about one anime: the full page, and Now Playing (which fills the hero slots and the
 * blocks around it with its playback state). Callers key it by anime id.
 */
export const AnimePage: React.FC<AnimePageProps> = ({
  anime,
  inList,
  listById,
  onOpenSeason,
  callbacks,
  playingEpisode = null,
  belowHero,
  footer,
  ...heroSlots
}) => {
  const showToast = useToast();
  const { searchTorrents } = useAnimeActions();
  const customListNames = useCustomLists().names;
  const editor = useEntryEditor({
    anime,
    inList,
    onUpdated: callbacks.onUpdated,
    onSavedInBackground: callbacks.onSavedInBackground,
  });
  const pinned = usePinnedRelease(anime.id);
  // Stored metadata (tags, studios, rankings, relations): fetched from AniList once if missing
  const [media, setMedia] = useState<SeasonalAnime | null>(null);
  const [synopsisOpen, setSynopsisOpen] = useState(false);

  const mediaId = anime.anilist_id ?? anime.id;
  useEffect(() => {
    let cancelled = false;
    toraApi
      .getMediaMetadata(mediaId)
      .then((m) => !cancelled && setMedia(m))
      .catch((e) => log.error("anime", "Failed to load media metadata", e));
    return () => {
      cancelled = true;
    };
  }, [mediaId]);

  const nextEpisode = anime.user_progress + 1;
  const nextFile = useMemo(
    () => pickEpisodeFile(editor.localFiles, nextEpisode, anime.episodes, pinned),
    [editor.localFiles, nextEpisode, anime.episodes, pinned]
  );
  const playNext = nextFile
    ? () =>
        toraApi
          .playEpisodeFile(nextFile.file_path)
          .then(() => showToast(`Playing episode ${nextEpisode}`, "info"))
          .catch((e) => showToast(String(e), "error"))
    : undefined;

  const relations = media?.metadata.relations ?? [];
  const details = useMediaDetails(mediaId);

  return (
    <div className="space-y-5">
      <AnimeHero anime={anime} inList={inList} metadata={media?.metadata ?? null} onPlayNext={playNext} {...heroSlots} />

      {belowHero}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
        <div className="lg:col-span-2 space-y-5 min-w-0">
          {inList && (
            <>
              <UserStatePanel anime={anime} editor={editor} />
              {customListNames.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary flex items-center gap-2">
                    <ListChecks className="w-4 h-4 text-accent" />
                    Custom Lists
                  </h3>
                  <CustomListsPanel animeIds={[anime.id]} variant="chips" />
                </div>
              )}
              <PageSection>
                <EpisodesPanel
                  anime={anime}
                  files={editor.localFiles}
                  progress={editor.progress}
                  playingEpisode={playingEpisode}
                  onMissingEpisode={() => searchTorrents(torrentSearchFor(anime))}
                />
              </PageSection>
            </>
          )}

          {anime.synopsis && (
            <PageSection title="Synopsis">
              <p
                className={`text-xs leading-relaxed text-text-secondary whitespace-pre-line ${synopsisOpen ? "" : "line-clamp-6"}`}
              >
                {anime.synopsis}
              </p>
              {anime.synopsis.length > 400 && (
                <button
                  onClick={() => setSynopsisOpen((v) => !v)}
                  className="text-[11px] font-semibold text-accent hover:underline"
                >
                  {synopsisOpen ? "Show less" : "Show more"}
                </button>
              )}
            </PageSection>
          )}

          {hasVisibleRelations(relations) && (
            <PageSection>
              <RelationsPanel relations={relations} listById={listById} />
            </PageSection>
          )}

          {details.details && details.details.characters.length > 0 && (
            <CharactersSection
              details={details.details}
              loading={details.loading}
              loadingMore={details.loadingMore}
              onLoadMore={details.loadMoreCharacters}
              onRefresh={details.refresh}
            />
          )}
          {details.details && <StaffSection anime={anime} details={details.details} />}
          {details.details && <RecommendationsSection details={details.details} listById={listById} />}
          {!details.details && details.loading && (
            <PageSection>
              <p className="text-xs text-text-muted">Loading characters, staff and recommendations…</p>
            </PageSection>
          )}
          {!details.details && !details.loading && details.error && (
            <PageSection>
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-text-muted">Characters, staff and recommendations could not be loaded.</p>
                <button onClick={details.refresh} className="text-[11px] font-semibold text-accent hover:underline">
                  Try again
                </button>
              </div>
            </PageSection>
          )}
        </div>

        <div className="space-y-5 min-w-0">
          <InfoPanel anime={anime} media={media} onOpenSeason={onOpenSeason} />
          {inList && <HistorySection anime={anime} />}
          <FollowingSection anime={anime} />
          {inList && <EntrySettings anime={anime} editor={editor} onDeleted={callbacks.onDeleted} />}
        </div>
      </div>

      {footer}
    </div>
  );
};
