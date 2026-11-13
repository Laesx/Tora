import React, { useMemo, useState } from "react";
import { ChevronUp, ExternalLink, Pin, PinOff, RefreshCw, StickyNote, UserCheck } from "lucide-react";
import { AnimeEntry, FollowingEntry, FollowingPage } from "@/lib/types";
import { anilistAnimeUrl, openExternal } from "@/lib/anime";
import { STATUS_INFO } from "@/lib/status";
import { formatRelativeTime } from "@/lib/format";
import { formatScore } from "@/lib/scores";
import { useScoreFormat } from "@/contexts/scoreFormat";
import { useToast } from "@/contexts/toast";
import { useNow } from "@/hooks/useNow";
import { PageSection } from "./PageSection";
import { togglePinnedUser, usePinnedUsers } from "./followingPins";

/** People listed before "Show all" (pinned ones always come first). */
const PREVIEW_COUNT = 5;

/**
 * The people the account follows who have this anime: status, progress, score (in this account's
 * format) and notes. Pinned people (this device only) come first on every anime. Fetched by the page
 * only while the section is open; the backend keeps them in memory for a few minutes, never stored.
 */
export const FollowingSection: React.FC<{
  anime: AnimeEntry;
  /** Null until loaded (or while the section is closed) */
  page: FollowingPage | null;
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}> = ({ anime, page, loading, refreshing, onRefresh }) => {
  const pins = usePinnedUsers();
  const [expanded, setExpanded] = useState(false);

  // Pinned people in the order they were pinned, then everyone else by last update
  const entries = useMemo(() => {
    const all = page?.entries ?? [];
    const pinned = pins.flatMap((id) => all.filter((e) => e.user_id === id));
    return [...pinned, ...all.filter((e) => !pins.includes(e.user_id))];
  }, [page, pins]);
  const shown = expanded ? entries : entries.slice(0, PREVIEW_COUNT);

  return (
    <PageSection
      id="following"
      title={
        <>
          <UserCheck className="w-4 h-4 text-accent" />
          Following
          {page && page.entries.length > 0 && (
            <span className="text-[11px] font-medium text-text-muted">
              {page.entries.length}
              {page.has_more ? "+" : ""}
            </span>
          )}
        </>
      }
      aside={
        <button
          onClick={onRefresh}
          disabled={refreshing}
          title="Refresh"
          className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
        </button>
      }
    >
      {!page ? (
        <p className="text-xs text-text-muted">{loading ? "Loading…" : ""}</p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-text-muted">Nobody you follow has this anime on their list.</p>
      ) : (
        <>
          <div className="space-y-1">
            {shown.map((e) => (
              <FollowingRow key={e.user_id} entry={e} anime={anime} pinned={pins.includes(e.user_id)} />
            ))}
          </div>
          <FollowingFooter
            hidden={entries.length - shown.length}
            expanded={expanded}
            canCollapse={entries.length > PREVIEW_COUNT}
            onToggle={() => setExpanded((v) => !v)}
            moreOnAniList={page.has_more ? anilistAnimeUrl(anime) : null}
          />
        </>
      )}
    </PageSection>
  );
};

/**
 * One person: name on its own line (the column is narrow), then status, progress and last update;
 * score, pin and notes on the right.
 */
const FollowingRow: React.FC<{ entry: FollowingEntry; anime: AnimeEntry; pinned: boolean }> = ({
  entry: e,
  anime,
  pinned,
}) => {
  const showToast = useToast();
  const scoreFormat = useScoreFormat();
  const now = useNow(60_000);
  const [noteOpen, setNoteOpen] = useState(false);
  const status = STATUS_INFO[e.status];
  const score = e.score > 0 ? formatScore(e.score, scoreFormat) : null;
  const progress = e.status === "COMPLETED" && !e.repeat ? null : `${e.progress}/${anime.episodes ?? "?"}`;
  const openProfile = () => openExternal(`https://anilist.co/user/${encodeURIComponent(e.user_name)}`, showToast);
  const PinIcon = pinned ? PinOff : Pin;
  return (
    <div className="group rounded-lg hover:bg-bg-tertiary/50 transition">
      <div className="flex items-center gap-2 px-1.5 py-1.5 min-w-0">
        <button
          onClick={openProfile}
          title={`${e.user_name} on AniList`}
          className="w-8 h-8 rounded-full overflow-hidden bg-bg-tertiary shrink-0"
        >
          {e.avatar && <img src={e.avatar} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 min-w-0">
            <button
              onClick={openProfile}
              title={`${e.user_name} on AniList`}
              className="text-xs font-semibold text-text-primary truncate hover:text-accent text-left"
            >
              {e.user_name}
            </button>
            {pinned && <Pin className="w-3 h-3 shrink-0 text-accent" aria-label="Pinned" />}
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-text-muted min-w-0">
            {status && <span className={`px-1.5 py-px rounded font-semibold shrink-0 ${status.badge}`}>{status.shortLabel}</span>}
            {progress && (
              <span className="font-mono text-text-secondary shrink-0" title="Progress">
                {progress}
              </span>
            )}
            {e.updated_at && <span className="truncate">{formatRelativeTime(e.updated_at, now, "short")}</span>}
          </div>
        </div>
        {score && (
          <span className="text-xs font-semibold text-amber-400 shrink-0" title="Score">
            {score}
          </span>
        )}
        <button
          onClick={() => togglePinnedUser(e.user_id)}
          title={pinned ? "Unpin" : "Pin: always listed first, on every anime (this device)"}
          className="p-1 rounded shrink-0 text-text-muted hover:text-accent opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition"
        >
          <PinIcon className="w-3.5 h-3.5" />
        </button>
        {e.notes && (
          <button
            onClick={() => setNoteOpen((v) => !v)}
            title={e.notes}
            className={`p-1 rounded shrink-0 transition ${noteOpen ? "text-accent" : "text-text-secondary hover:text-accent"}`}
          >
            <StickyNote className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {noteOpen && e.notes && (
        <p className="pl-12 pr-2 pb-2 text-[11px] text-text-secondary whitespace-pre-line break-words">{e.notes}</p>
      )}
    </div>
  );
};

const FollowingFooter: React.FC<{
  hidden: number;
  expanded: boolean;
  canCollapse: boolean;
  onToggle: () => void;
  moreOnAniList: string | null;
}> = ({ hidden, expanded, canCollapse, onToggle, moreOnAniList }) => {
  const showToast = useToast();
  if (!canCollapse && !moreOnAniList) return null;
  return (
    <div className="flex items-center justify-between gap-2">
      {canCollapse ? (
        <button onClick={onToggle} className="flex items-center gap-1 text-[11px] font-semibold text-accent hover:underline">
          {expanded ? (
            <>
              <ChevronUp className="w-3.5 h-3.5" />
              Show fewer
            </>
          ) : (
            `Show ${hidden} more`
          )}
        </button>
      ) : (
        <span />
      )}
      {moreOnAniList && expanded && (
        <button
          onClick={() => openExternal(moreOnAniList, showToast)}
          className="flex items-center gap-1 text-[11px] font-semibold text-text-secondary hover:text-accent"
        >
          <ExternalLink className="w-3 h-3" />
          More on AniList
        </button>
      )}
    </div>
  );
};
