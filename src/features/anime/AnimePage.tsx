import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimeEntry } from "@/lib/types";
import { toraApi } from "@/lib/api";
import { torrentSearchFor } from "@/lib/torrents";
import { pickEpisodeFile, usePinnedRelease } from "@/lib/releases";
import { useToast } from "@/contexts/toast";
import { useAnimeActions } from "@/contexts/animeActions";
import { useCustomLists } from "@/contexts/customLists";
import { CustomListsPanel } from "@/components/CustomListsPanel";
import { useEntryEditor } from "@/features/detail/useEntryEditor";
import { UserStatePanel } from "@/features/detail/UserStatePanel";
import { EpisodesPanel } from "@/features/detail/EpisodesPanel";
import { RelationsPanel, hasVisibleRelations, sourceRelations } from "@/features/detail/RelationsPanel";
import { EntrySettings } from "@/features/detail/EntrySettings";
import { AnimeHero, AnimeHeroSlots } from "./AnimeHero";
import { InfoPanel } from "./InfoPanel";
import { PageSection } from "./PageSection";
import { SynopsisSection } from "./SynopsisSection";
import { useAnimePageData } from "./useAnimePageData";
import { useSectionCollapsed } from "./sectionPrefs";
import { CharactersSection } from "./CharactersSection";
import { StaffSection } from "./StaffSection";
import { RecommendationsSection } from "./RecommendationsSection";
import { HistorySection } from "./HistorySection";
import { FollowingSection } from "./FollowingSection";

/** Page widths (px) for three and two columns. */
const WIDE_LAYOUT = 1300;
const MEDIUM_LAYOUT = 900;

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
  // Metadata (tags, studios, rankings, relations), details and followed users: one backend call, at
  // most one AniList request. Closed Recommendations / Following sections fetch nothing.
  const mediaId = anime.anilist_id ?? anime.id;
  const recommendationsOpen = !useSectionCollapsed("recommendations");
  const followingOpen = !useSectionCollapsed("following");
  const page = useAnimePageData(mediaId, { recommendations: recommendationsOpen, following: followingOpen });
  const media = page.data?.media ?? null;
  const details = page.data?.details ?? null;

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

  // Columns follow the page's own width (the sidebar takes part of the window)
  const rootRef = useRef<HTMLDivElement | null>(null);
  const leftRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(1200);
  const [leftFits, setLeftFits] = useState(false);
  const columns = width >= WIDE_LAYOUT ? 3 : width >= MEDIUM_LAYOUT ? 2 : 1;
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      setWidth(root.clientWidth);
      // The left column stays in view while scrolling only when all of it fits in the window
      const left = leftRef.current;
      setLeftFits(left !== null && left.offsetHeight <= window.innerHeight - 140);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    if (leftRef.current) ro.observe(leftRef.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [columns]);

  const sections: Record<string, React.ReactNode> = {
    // Custom lists belong to your entry: the last row of its box
    userState: inList && (
      <UserStatePanel
        anime={anime}
        editor={editor}
        compact={columns > 1}
        extra={
          customListNames.length > 0
            ? { label: "Custom Lists", content: <CustomListsPanel animeIds={[anime.id]} variant="chips" /> }
            : undefined
        }
      />
    ),
    episodes: inList && (
      <PageSection>
        <EpisodesPanel
          anime={anime}
          files={editor.localFiles}
          progress={editor.progress}
          playingEpisode={playingEpisode}
          onMissingEpisode={() => searchTorrents(torrentSearchFor(anime))}
        />
      </PageSection>
    ),
    synopsis: anime.synopsis && <SynopsisSection synopsis={anime.synopsis} />,
    characters: details && details.characters.length > 0 && (
      <CharactersSection
        details={details}
        loading={page.refreshing === "details"}
        loadingMore={page.loadingMore}
        onLoadMore={page.loadMoreCharacters}
        onRefresh={page.refreshDetails}
      />
    ),
    staff: details && <StaffSection anime={anime} details={details} />,
    recommendations: (details || !recommendationsOpen) && (
      <RecommendationsSection details={details} loading={page.loading} listById={listById} />
    ),
    detailsStatus: !details && (page.loading || page.data?.error) && (
      <PageSection>
        {page.loading ? (
          <p className="text-xs text-text-muted">Loading characters and staff…</p>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-text-muted">Characters and staff could not be loaded.</p>
            <button onClick={page.refreshDetails} className="text-[11px] font-semibold text-accent hover:underline">
              Try again
            </button>
          </div>
        )}
      </PageSection>
    ),
    info: <InfoPanel anime={anime} media={media} sources={sourceRelations(relations)} onOpenSeason={onOpenSeason} />,
    history: inList && <HistorySection anime={anime} />,
    following: (page.data?.signed_in ?? true) && (
      <FollowingSection
        anime={anime}
        page={page.data?.following ?? null}
        loading={page.loading}
        refreshing={page.refreshing === "following"}
        onRefresh={page.refreshFollowing}
      />
    ),
    settings: inList && <EntrySettings anime={anime} editor={editor} onDeleted={callbacks.onDeleted} />,
  };
  const column = (names: string[], className = "", ref?: React.Ref<HTMLDivElement>) => (
    <div ref={ref} className={`space-y-5 min-w-0 ${className}`}>
      {names.map((n) => sections[n] && <React.Fragment key={n}>{sections[n]}</React.Fragment>)}
    </div>
  );

  return (
    <div ref={rootRef} className="pb-6">
      <AnimeHero anime={anime} inList={inList} metadata={media?.metadata ?? null} onPlayNext={playNext} {...heroSlots} />

      <div className="px-6 pt-6 space-y-5">
        {belowHero}

        {/* Related: one thin row of cards across the page (the rest on demand); sources are under Information */}
        {hasVisibleRelations(relations, true) && (
          <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-2">
            <RelationsPanel relations={relations} listById={listById} maxRows={1} bare />
          </div>
        )}

        {columns === 3 ? (
          <div className="grid gap-5 items-start" style={{ gridTemplateColumns: "280px minmax(0, 1fr) 340px" }}>
            {column(["userState", "info", "settings"], leftFits ? "sticky top-4 self-start" : "", leftRef)}
            {column(["episodes", "synopsis", "characters", "staff", "detailsStatus"])}
            {column(["following", "history", "recommendations"])}
          </div>
        ) : columns === 2 ? (
          <div className="grid gap-5 items-start" style={{ gridTemplateColumns: "minmax(0, 1fr) 320px" }}>
            {column(["episodes", "synopsis", "characters", "staff", "detailsStatus", "recommendations"])}
            {column(["userState", "info", "following", "history", "settings"])}
          </div>
        ) : (
          column([
            "userState",
            "episodes",
            "synopsis",
            "characters",
            "staff",
            "detailsStatus",
            "recommendations",
            "info",
            "history",
            "following",
            "settings",
          ])
        )}

        {footer}
      </div>
    </div>
  );
};
