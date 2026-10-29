import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  ExternalLink,
  FolderOpen,
  Link2,
  Magnet,
  Pencil,
  Play,
  Search,
  Star,
} from "lucide-react";
import {
  AnimeEntry,
  AppSettings,
  DetectedMediaSession,
  LocalEpisodeFile,
  SeasonalAnime,
} from "../types";
import { formatCountdown, getOptimizedCoverUrl, toraApi } from "../api";
import { seasonName } from "../seasons";
import {
  anilistAnimeUrl,
  anilistGenreUrl,
  anilistStudioUrl,
  anilistTagUrl,
  formatEnum,
  formatFuzzyDate,
  formatRanking,
  openAnimeFolder,
  openExternal,
} from "../nowPlaying";
import { LIST_STATUS_META } from "./AnimePosterCard";
import { altTitles, useAnimeTitle, useTitleLanguage } from "../titles";
import { TorrentSearchRequest, stripSeasonSuffix, torrentSearchFor } from "../torrents";
import { episodeBar, episodeTotalLabel } from "../episodes";
import { EpisodeProgressBar, ReadyBadge } from "./EpisodeProgressBar";
import { AiringDot } from "./AiringDot";

interface NowPlayingHeroProps {
  session: DetectedMediaSession;
  /** The matched list entry (undefined while unmatched) */
  entry: AnimeEntry | undefined;
  animeList: AnimeEntry[];
  settings: AppSettings;
  onLinkDetectedEpisode: (animeId: number, aliasTitle: string) => Promise<void>;
  onOpenAnime: (anime: AnimeEntry) => void;
  /** Show this season in the Seasons tab */
  onOpenSeason: (season: string, year: number) => void;
  onSearchTorrents: (req: TorrentSearchRequest) => void;
  showToast: (msg: string, type?: "success" | "info" | "error") => void;
}

const MAX_TAGS = 12;

const chipClass =
  "px-2 py-0.5 rounded-md bg-bg-tertiary text-text-secondary hover:text-accent hover:bg-accent/10 text-[11px] font-medium transition cursor-pointer";

export const NowPlayingHero: React.FC<NowPlayingHeroProps> = ({
  session,
  entry,
  animeList,
  settings,
  onLinkDetectedEpisode,
  onOpenAnime,
  onOpenSeason,
  onSearchTorrents,
  showToast,
}) => {
  const titleOf = useAnimeTitle();
  const titleLanguage = useTitleLanguage();
  const [isRelinking, setIsRelinking] = useState(false);
  const [media, setMedia] = useState<SeasonalAnime | null>(null);
  const [localFiles, setLocalFiles] = useState<LocalEpisodeFile[]>([]);
  const [showSpoilers, setShowSpoilers] = useState(false);
  const [synopsisOpen, setSynopsisOpen] = useState(false);

  useEffect(() => {
    setIsRelinking(false);
  }, [session.cleaned_media_title, session.matched_anime_id]);

  // Stored metadata only: fetched from AniList once if this anime has none, never refreshed on play
  const mediaId = entry ? entry.anilist_id ?? entry.id : null;
  useEffect(() => {
    setMedia(null);
    setShowSpoilers(false);
    setSynopsisOpen(false);
    if (mediaId === null) return;
    let cancelled = false;
    toraApi
      .getMediaMetadata(mediaId)
      .then((m) => !cancelled && setMedia(m))
      .catch((e) => console.error("Failed to load media metadata:", e));
    return () => {
      cancelled = true;
    };
  }, [mediaId]);

  const entryId = entry?.id ?? null;
  const onDiskCount = entry?.available_episodes.length ?? 0;
  useEffect(() => {
    if (entryId === null) {
      setLocalFiles([]);
      return;
    }
    let cancelled = false;
    toraApi
      .getLocalEpisodes(entryId)
      .then((files) => !cancelled && setLocalFiles(files))
      .catch(() => !cancelled && setLocalFiles([]));
    return () => {
      cancelled = true;
    };
  }, [entryId, onDiskCount]);

  const fileByEpisode = useMemo(() => {
    const map = new Map<number, LocalEpisodeFile>();
    for (const f of localFiles) {
      if (f.episode_number !== null && !map.has(f.episode_number)) map.set(f.episode_number, f);
    }
    return map;
  }, [localFiles]);

  const ep = session.parsed.episode_number;
  const meta = media?.metadata;
  const title = (entry && titleOf(entry)) || session.matched_anime_title || session.parsed.anime_title;
  const subtitles = entry ? altTitles(entry, titleLanguage) : [];
  const progress = entry?.user_progress ?? session.matched_current_progress ?? 0;
  const total = entry?.episodes ?? session.matched_total_episodes ?? null;
  const alreadySeen = ep !== null && session.matched_current_progress !== null && ep <= session.matched_current_progress;

  const studios = meta?.studios.filter((s) => s.is_animation_studio) ?? [];
  const producers = meta?.studios.filter((s) => !s.is_animation_studio) ?? [];
  const tags = useMemo(
    () =>
      (meta?.tags ?? [])
        .filter((t) => showSpoilers || !t.is_spoiler)
        .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))
        .slice(0, MAX_TAGS),
    [meta, showSpoilers]
  );
  const hasSpoilerTags = meta?.tags.some((t) => t.is_spoiler) ?? false;
  const rankings = useMemo(
    () =>
      (meta?.rankings ?? [])
        .slice()
        .sort((a, b) => Number(a.all_time) - Number(b.all_time) || a.rank - b.rank)
        .slice(0, 4),
    [meta]
  );

  const openOnAnilist = () => entry && openExternal(anilistAnimeUrl(entry), showToast);

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
    <span className="px-2.5 py-1 rounded-lg bg-bg-tertiary text-text-muted text-[11px] font-semibold">
      Already watched
    </span>
  ) : (
    <span className="px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-300 text-[11px] font-mono flex items-center gap-1.5">
      <Clock className="w-3.5 h-3.5" />
      Updating in {Math.max(0, settings.recognition_delay_seconds - session.elapsed_seconds)}s
    </span>
  );

  const infoRows: { label: string; value: React.ReactNode }[] = entry
    ? [
        { label: "Type", value: formatEnum(entry.format) },
        { label: "Episodes", value: entry.episodes ?? "?" },
        { label: "Duration", value: entry.duration ? `${entry.duration} min` : null },
        { label: "Status", value: formatEnum(entry.airing_status) },
        {
          label: "Season",
          value:
            entry.season && entry.season_year ? (
              <button
                onClick={() => onOpenSeason(entry.season!, entry.season_year!)}
                title="Open this season"
                className="text-accent hover:underline"
              >
                {seasonName(entry.season)} {entry.season_year}
              </button>
            ) : null,
        },
        {
          label: "Aired",
          value: entry.start_date
            ? `${formatFuzzyDate(entry.start_date)} – ${formatFuzzyDate(entry.end_date) ?? "?"}`
            : null,
        },
        { label: "Source", value: entry.source_material ? formatEnum(entry.source_material) : null },
        {
          label: "Studios",
          value:
            studios.length > 0 ? (
              <span className="flex flex-wrap gap-x-2 gap-y-0.5">
                {studios.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => openExternal(anilistStudioUrl(s.id), showToast)}
                    className="text-accent hover:underline"
                  >
                    {s.name}
                  </button>
                ))}
              </span>
            ) : entry.studios.length > 0 ? (
              entry.studios.join(", ")
            ) : null,
        },
        {
          label: "Producers",
          value:
            producers.length > 0 ? (
              <span className="flex flex-wrap gap-x-2 gap-y-0.5">
                {producers.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => openExternal(anilistStudioUrl(s.id), showToast)}
                    className="text-text-secondary hover:text-accent hover:underline"
                  >
                    {s.name}
                  </button>
                ))}
              </span>
            ) : null,
        },
        { label: "Average score", value: entry.average_score ? `${entry.average_score}%` : null },
        { label: "Mean score", value: meta?.mean_score ? `${meta.mean_score}%` : null },
        { label: "Popularity", value: media?.popularity?.toLocaleString() ?? null },
        { label: "Favourites", value: meta?.favourites?.toLocaleString() ?? null },
      ].filter((r) => r.value !== null && r.value !== undefined && r.value !== "")
    : [];

  const maxEpisode = Math.max(total ?? 0, ...(entry?.available_episodes ?? [0]));
  const bar = entry ? episodeBar(entry) : null;
  const totalLabel = entry ? episodeTotalLabel(entry) : total ? String(total) : null;

  return (
    <div className="space-y-5">
      {/* Hero */}
      <div className="relative rounded-2xl overflow-hidden border border-border-subtle bg-bg-secondary">
        {entry?.banner_image ? (
          <img
            src={entry.banner_image}
            alt=""
            decoding="async"
            className="absolute inset-0 w-full h-full object-cover opacity-25"
          />
        ) : entry?.cover_color ? (
          <div className="absolute inset-0 opacity-20" style={{ background: entry.cover_color }} />
        ) : null}
        <div className="absolute inset-0 bg-gradient-to-r from-bg-secondary via-bg-secondary/90 to-bg-secondary/60" />

        <div className="relative flex flex-col sm:flex-row gap-6 p-6">
          {entry || session.matched_cover_image ? (
            <button
              onClick={openOnAnilist}
              disabled={!entry}
              title="Open on AniList"
              className="group relative w-40 shrink-0 self-start rounded-xl overflow-hidden border border-border-subtle shadow-lg"
            >
              <img
                src={getOptimizedCoverUrl(entry?.cover_image || session.matched_cover_image, "large")}
                alt={title}
                decoding="async"
                className="w-40 aspect-[2/3] object-cover"
              />
              {entry && <AiringDot anime={entry} onCover className="absolute top-2 left-2" />}
              {entry && (
                <span className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition flex items-center justify-center text-white text-xs font-semibold gap-1.5">
                  <ExternalLink className="w-4 h-4" />
                  AniList
                </span>
              )}
            </button>
          ) : (
            <div className="w-40 aspect-[2/3] shrink-0 rounded-xl border border-dashed border-border-subtle flex items-center justify-center text-text-muted">
              <Search className="w-6 h-6" />
            </div>
          )}

          <div className="flex-1 min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="px-2.5 py-1 rounded-lg bg-accent text-white text-[11px] font-bold flex items-center gap-1.5">
                <Play className="w-3 h-3 fill-current" />
                {session.player_name}
              </span>
              {statusChip}
              {entry && LIST_STATUS_META[entry.user_status] && (
                <span
                  className={`px-2 py-1 rounded-lg text-[11px] font-semibold ${LIST_STATUS_META[entry.user_status].badge}`}
                >
                  {LIST_STATUS_META[entry.user_status].label}
                </span>
              )}
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
            </div>

            <div>
              <h2 className="text-2xl font-extrabold text-text-primary leading-tight">{title}</h2>
              {subtitles.length > 0 && (
                <div className="text-sm text-text-secondary mt-0.5">{subtitles.join(" · ")}</div>
              )}
            </div>

            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="text-lg font-bold text-accent">
                Episode {ep ?? "?"}
                {totalLabel && totalLabel !== "?" ? (
                  <span className="text-text-muted font-semibold"> / {totalLabel}</span>
                ) : null}
              </span>
              {session.matched_anime_id && (
                <span className="text-xs text-text-muted">Your progress: {progress}</span>
              )}
              {entry && entry.user_score > 0 && (
                <span className="text-xs text-text-secondary flex items-center gap-1">
                  <Star className="w-3.5 h-3.5 text-amber-400 fill-current" />
                  {entry.user_score}
                </span>
              )}
              {entry?.next_airing_episode && entry.next_airing_at && (
                <span className="text-xs text-emerald-400 font-mono flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5" />
                  Ep {entry.next_airing_episode} in {formatCountdown(entry.next_airing_at)}
                </span>
              )}
            </div>
            {entry && bar ? (
              <div className="flex items-center gap-2 max-w-md">
                <EpisodeProgressBar bar={bar} className="flex-1 h-2.5 rounded-full" />
                <ReadyBadge bar={bar} progress={entry.user_progress} />
              </div>
            ) : total ? (
              <div className="h-1.5 rounded-full bg-bg-tertiary overflow-hidden max-w-md">
                <div
                  className="h-full bg-accent rounded-full transition-all"
                  style={{ width: `${Math.min(100, (progress / total) * 100)}%` }}
                />
              </div>
            ) : null}

            {/* Actions */}
            <div className="flex flex-wrap gap-2 pt-1">
              {entry && (
                <button
                  onClick={() => onOpenAnime(entry)}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-accent hover:bg-accent-hover text-white text-xs font-bold transition"
                >
                  <Pencil className="w-3.5 h-3.5" />
                  Edit
                </button>
              )}
              {entry && (
                <button
                  onClick={() => openAnimeFolder(entry, showToast)}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated text-text-secondary hover:text-text-primary text-xs font-semibold transition"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  Open folder
                </button>
              )}
              {session.matched_anime_id && !isRelinking && (
                <button
                  onClick={() => setIsRelinking(true)}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated text-text-secondary hover:text-text-primary text-xs font-semibold transition"
                >
                  <Link2 className="w-3.5 h-3.5" />
                  Change linked anime
                </button>
              )}
              <button
                onClick={() =>
                  onSearchTorrents(
                    entry
                      ? torrentSearchFor(entry)
                      : { query: stripSeasonSuffix(session.parsed.anime_title || title), animeId: null }
                  )
                }
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated text-text-secondary hover:text-text-primary text-xs font-semibold transition"
              >
                <Magnet className="w-3.5 h-3.5" />
                Search torrents
              </button>
            </div>

            {/* Genres & tags */}
            {entry && (entry.genres.length > 0 || tags.length > 0) && (
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                {entry.genres.map((g) => (
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

      {(!session.matched_anime_id || isRelinking) && (
        <LinkAnimePanel
          session={session}
          animeList={animeList}
          isRelinking={isRelinking}
          onCancel={() => setIsRelinking(false)}
          onLink={async (animeId, alias) => {
            await onLinkDetectedEpisode(animeId, alias);
            setIsRelinking(false);
          }}
          showToast={showToast}
        />
      )}

      {entry && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <div className="lg:col-span-2 space-y-5">
            {entry.synopsis && (
              <section className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-2">
                <h3 className="text-sm font-bold text-text-primary">Synopsis</h3>
                <p
                  className={`text-xs leading-relaxed text-text-secondary whitespace-pre-line ${synopsisOpen ? "" : "line-clamp-6"}`}
                >
                  {entry.synopsis}
                </p>
                {entry.synopsis.length > 400 && (
                  <button
                    onClick={() => setSynopsisOpen((v) => !v)}
                    className="text-[11px] font-semibold text-accent hover:underline"
                  >
                    {synopsisOpen ? "Show less" : "Show more"}
                  </button>
                )}
              </section>
            )}

            {maxEpisode > 0 && (
              <section className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-3">
                <h3 className="text-sm font-bold text-text-primary flex items-center gap-2">
                  Episodes
                  <span className="text-[11px] font-medium text-text-muted">
                    {entry.available_episodes.length} on disk
                  </span>
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {Array.from({ length: maxEpisode }, (_, i) => i + 1).map((n) => {
                    const file = fileByEpisode.get(n);
                    const watched = n <= progress;
                    const playing = n === ep;
                    return (
                      <button
                        key={n}
                        disabled={!file}
                        onClick={() => file && toraApi.playEpisodeFile(file.file_path).catch((e) => showToast(String(e), "error"))}
                        title={file ? `Play ${file.file_name}` : "Not on disk"}
                        className={`w-9 h-8 rounded-lg text-[11px] font-mono font-semibold transition ${
                          playing
                            ? "bg-accent text-white"
                            : file
                              ? watched
                                ? "bg-bg-tertiary text-text-muted hover:text-text-primary"
                                : "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25"
                              : "bg-bg-primary text-text-muted/50 border border-border-subtle cursor-default"
                        }`}
                      >
                        {n}
                      </button>
                    );
                  })}
                </div>
              </section>
            )}
          </div>

          <section className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-3 self-start">
            <h3 className="text-sm font-bold text-text-primary">Information</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
              {infoRows.map((r) => (
                <React.Fragment key={r.label}>
                  <dt className="text-text-muted">{r.label}</dt>
                  <dd className="text-text-primary min-w-0">{r.value}</dd>
                </React.Fragment>
              ))}
            </dl>
            {rankings.length > 0 && (
              <div className="pt-2 border-t border-border-subtle space-y-1">
                {rankings.map((r, i) => (
                  <div key={i} className="text-[11px] text-text-secondary flex items-center gap-1.5">
                    <Star className="w-3 h-3 text-amber-400" />
                    {formatRanking(r)}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      <div className="text-[11px] font-mono text-text-muted truncate" title={session.raw_window_title}>
        {session.raw_window_title}
      </div>
    </div>
  );
};

interface LinkAnimePanelProps {
  session: DetectedMediaSession;
  animeList: AnimeEntry[];
  isRelinking: boolean;
  onCancel: () => void;
  onLink: (animeId: number, aliasTitle: string) => Promise<void>;
  showToast: (msg: string, type?: "success" | "info" | "error") => void;
}

/** Lets the user link the detected title to a list entry (saved as an alias for later episodes). */
const LinkAnimePanel: React.FC<LinkAnimePanelProps> = ({
  session,
  animeList,
  isRelinking,
  onCancel,
  onLink,
  showToast,
}) => {
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
