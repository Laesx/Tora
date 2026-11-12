import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Link2, Magnet, Play, Search } from "lucide-react";
import { AnimeEntry, AppSettings, DetectedMediaSession } from "@/lib/types";
import { getOptimizedCoverUrl } from "@/lib/covers";
import { useAnimeTitle } from "@/contexts/titles";
import { stripSeasonSuffix } from "@/lib/torrents";
import { useToast } from "@/contexts/toast";
import { useAnimeActions } from "@/contexts/animeActions";
import { UpdateCountdown } from "@/components/UpdateCountdown";
import { AnimePage, EntryCallbacks } from "@/features/anime/AnimePage";

interface NowPlayingHeroProps {
  session: DetectedMediaSession;
  /** The matched list entry (undefined while unmatched) */
  entry: AnimeEntry | undefined;
  animeList: AnimeEntry[];
  listById: Map<number, AnimeEntry>;
  settings: AppSettings;
  callbacks: EntryCallbacks;
  onLinkDetectedEpisode: (animeId: number, aliasTitle: string) => Promise<void>;
  /** Manual update mode's "Update" button */
  onConfirmUpdate: () => void;
  /** Show this season in the Seasons tab */
  onOpenSeason: (season: string, year: number) => void;
}

const secondaryButton =
  "flex items-center gap-1.5 px-3 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated text-text-secondary hover:text-text-primary text-xs font-semibold transition";

/**
 * A matched file: the anime page with the playback layer in its slots (player, update state, the episode
 * playing, relinking). An unmatched one: what the player shows, and the panel to link it.
 */
export const NowPlayingHero: React.FC<NowPlayingHeroProps> = ({
  session,
  entry,
  animeList,
  listById,
  settings,
  callbacks,
  onLinkDetectedEpisode,
  onConfirmUpdate,
  onOpenSeason,
}) => {
  const { searchTorrents } = useAnimeActions();
  const [isRelinking, setIsRelinking] = useState(false);

  useEffect(() => {
    setIsRelinking(false);
  }, [session.cleaned_media_title, session.matched_anime_id]);

  const ep = session.parsed.episode_number;
  const alreadySeen = ep !== null && session.matched_current_progress !== null && ep <= session.matched_current_progress;

  const statusChip = !session.matched_anime_id ? (
    <span className="px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[11px] font-semibold flex items-center gap-1.5">
      <AlertTriangle className="w-3.5 h-3.5" />
      Unmatched anime
    </span>
  ) : session.auto_synced ? (
    <span className="px-2.5 py-1 rounded-lg bg-emerald-500/20 text-emerald-400 text-[11px] font-semibold flex items-center gap-1.5">
      <CheckCircle2 className="w-3.5 h-3.5" />
      Progress updated
    </span>
  ) : alreadySeen ? (
    <span className="px-2.5 py-1 rounded-lg bg-bg-tertiary text-text-muted text-[11px] font-semibold">Already watched</span>
  ) : session.awaiting_confirmation ? (
    <button
      onClick={onConfirmUpdate}
      className="px-2.5 py-1 rounded-lg bg-accent hover:bg-accent-hover text-white text-[11px] font-semibold flex items-center gap-1.5 transition cursor-pointer"
    >
      <CheckCircle2 className="w-3.5 h-3.5" />
      Update to episode {ep}
    </button>
  ) : session.waiting_for_close ? (
    <span className="px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-300 text-[11px] font-semibold flex items-center gap-1.5">
      <Clock className="w-3.5 h-3.5" />
      Updates when the player closes
    </span>
  ) : (
    <span className="px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-300 text-[11px] font-mono flex items-center gap-1.5">
      <Clock className="w-3.5 h-3.5" />
      Updating in <UpdateCountdown session={session} delaySeconds={settings.recognition_delay_seconds} />s
    </span>
  );

  const badges = (
    <>
      <span className="px-2.5 py-1 rounded-lg bg-accent text-white text-[11px] font-bold flex items-center gap-1.5">
        <Play className="w-3 h-3 fill-current" />
        {session.player_name}
      </span>
      {statusChip}
      {session.parsed.video_resolution && (
        <span className="px-2 py-1 rounded-lg bg-bg-tertiary text-emerald-400 font-mono text-[11px]">
          {session.parsed.video_resolution}
        </span>
      )}
      {session.parsed.release_group && (
        <span className="px-2 py-1 rounded-lg bg-bg-tertiary text-text-secondary text-[11px]">
          {session.parsed.release_group}
        </span>
      )}
    </>
  );

  const linkPanel =
    !session.matched_anime_id || isRelinking ? (
      <LinkAnimePanel
        session={session}
        animeList={animeList}
        isRelinking={isRelinking}
        onCancel={() => setIsRelinking(false)}
        onLink={async (animeId, alias) => {
          await onLinkDetectedEpisode(animeId, alias);
          setIsRelinking(false);
        }}
      />
    ) : null;

  const windowTitle = (
    <div className="text-[11px] font-mono text-text-muted truncate" title={session.raw_window_title}>
      {session.raw_window_title}
    </div>
  );

  if (entry) {
    const total = entry.episodes;
    return (
      <AnimePage
        key={entry.id}
        anime={entry}
        inList
        listById={listById}
        onOpenSeason={onOpenSeason}
        callbacks={callbacks}
        playingEpisode={ep}
        hidePlayNext
        badges={badges}
        episodeLine={
          <>
            <span className="text-lg font-bold text-accent">
              Episode {ep ?? "?"}
              {total ? <span className="text-text-muted font-semibold"> / {total}</span> : null}
            </span>
            <span className="text-xs text-text-muted">Your progress: {entry.user_progress}</span>
          </>
        }
        actions={
          !isRelinking && (
            <button onClick={() => setIsRelinking(true)} className={secondaryButton}>
              <Link2 className="w-3.5 h-3.5" />
              Change linked anime
            </button>
          )
        }
        belowHero={linkPanel}
        footer={windowTitle}
      />
    );
  }

  // Unmatched (or matched to an entry the list does not hold yet): only what the player says
  const title = session.matched_anime_title || session.parsed.anime_title || session.cleaned_media_title;
  return (
    <div className="space-y-5">
      <div className="relative rounded-2xl overflow-hidden border border-border-subtle bg-bg-secondary">
        <div className="relative flex flex-col sm:flex-row gap-6 p-6">
          {session.matched_cover_image ? (
            <img
              src={getOptimizedCoverUrl(session.matched_cover_image, "large")}
              alt={title}
              decoding="async"
              className="w-40 aspect-[2/3] shrink-0 self-start rounded-xl object-cover border border-border-subtle shadow-lg"
            />
          ) : (
            <div className="w-40 aspect-[2/3] shrink-0 rounded-xl border border-dashed border-border-subtle flex items-center justify-center text-text-muted">
              <Search className="w-6 h-6" />
            </div>
          )}
          <div className="flex-1 min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">{badges}</div>
            <h2 className="text-2xl font-extrabold text-text-primary leading-tight">{title}</h2>
            <div className="text-lg font-bold text-accent">
              Episode {ep ?? "?"}
              {session.matched_total_episodes ? (
                <span className="text-text-muted font-semibold"> / {session.matched_total_episodes}</span>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                onClick={() =>
                  searchTorrents({ query: stripSeasonSuffix(session.parsed.anime_title || title), animeId: null })
                }
                className={secondaryButton}
              >
                <Magnet className="w-3.5 h-3.5" />
                Search torrents
              </button>
            </div>
          </div>
        </div>
      </div>
      {linkPanel}
      {windowTitle}
    </div>
  );
};

interface LinkAnimePanelProps {
  session: DetectedMediaSession;
  animeList: AnimeEntry[];
  isRelinking: boolean;
  onCancel: () => void;
  onLink: (animeId: number, aliasTitle: string) => Promise<void>;
}

/** Lets the user link the detected title to a list entry (saved as an alias for later episodes). */
const LinkAnimePanel: React.FC<LinkAnimePanelProps> = ({
  session,
  animeList,
  isRelinking,
  onCancel,
  onLink,
}) => {
  const showToast = useToast();
  const titleOf = useAnimeTitle();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(session.matched_anime_id);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSelectedId(session.matched_anime_id ?? null);
  }, [session.cleaned_media_title, session.matched_anime_id]);

  const choices = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = !q
      ? animeList
      : animeList.filter(
          (a) =>
            a.title_romaji.toLowerCase().includes(q) ||
            (a.title_english && a.title_english.toLowerCase().includes(q)) ||
            a.synonyms.some((s) => s.toLowerCase().includes(q))
        );
    return list.slice(0, 48);
  }, [animeList, search]);

  const handleConfirm = async () => {
    const alias = session.parsed.anime_title.trim() || session.cleaned_media_title.trim();
    if (!selectedId || !alias) return;
    setBusy(true);
    try {
      await onLink(selectedId, alias);
      showToast(`Saved relation "${alias}" — later episodes will match automatically`, "success");
    } catch (err) {
      showToast(String(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 rounded-2xl bg-bg-secondary border border-amber-500/40 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-xs font-bold text-amber-300 flex items-center gap-1.5">
            <Link2 className="w-4 h-4" />
            {session.matched_anime_id ? "Change linked anime" : "Which anime is this?"}
          </h3>
          <p className="text-[11px] text-text-secondary mt-0.5">
            Link{" "}
            <span className="font-mono text-text-primary font-semibold">"{session.parsed.anime_title}"</span> to
            an entry in your list. Tora saves this relation so later episodes match automatically.
          </p>
        </div>
        {isRelinking && (
          <button
            onClick={onCancel}
            className="px-2.5 py-1 rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary text-xs"
          >
            Cancel
          </button>
        )}
      </div>

      <div className="relative">
        <Search className="w-3.5 h-3.5 text-text-muted absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search your list by title or alternative name..."
          className="w-full pl-8 pr-3 py-2 rounded-xl bg-bg-primary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-60 overflow-y-auto pr-1">
        {choices.map((anime) => (
          <button
            key={anime.id}
            type="button"
            onClick={() => setSelectedId(anime.id)}
            className={`flex items-center gap-3 p-2.5 rounded-xl border text-left transition ${
              selectedId === anime.id
                ? "bg-accent/20 border-accent text-text-primary"
                : "bg-bg-primary border-border-subtle text-text-secondary hover:text-text-primary"
            }`}
          >
            <img
              src={getOptimizedCoverUrl(anime.cover_image, "medium")}
              alt={titleOf(anime)}
              loading="lazy"
              decoding="async"
              className="w-9 h-12 object-cover rounded-md shrink-0"
            />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-bold text-text-primary truncate">{titleOf(anime)}</div>
              {anime.title_english && (
                <div className="text-[10px] text-text-muted truncate">{anime.title_english}</div>
              )}
              <div className="text-[10px] font-mono text-accent mt-0.5">
                Ep {anime.user_progress}/{anime.episodes ?? "?"} · {anime.user_status}
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="flex justify-end pt-1">
        <button
          type="button"
          disabled={!selectedId || busy}
          onClick={handleConfirm}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-accent hover:bg-accent-hover disabled:opacity-40 text-white text-xs font-bold transition"
        >
          <Link2 className="w-3.5 h-3.5" />
          {busy ? "Saving..." : "Link anime"}
        </button>
      </div>
    </div>
  );
};
