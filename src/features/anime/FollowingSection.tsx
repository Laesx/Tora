import React, { useEffect, useState } from "react";
import { ExternalLink, RefreshCw, StickyNote, UserCheck } from "lucide-react";
import { AnimeEntry, FollowingPage } from "@/lib/types";
import { toraApi } from "@/lib/api";
import { log } from "@/lib/log";
import { anilistAnimeUrl, openExternal } from "@/lib/anime";
import { STATUS_INFO } from "@/lib/status";
import { formatRelativeTime } from "@/lib/format";
import { formatScore } from "@/lib/scores";
import { useScoreFormat } from "@/contexts/scoreFormat";
import { useToast } from "@/contexts/toast";
import { useNow } from "@/hooks/useNow";
import { PageSection } from "./PageSection";
import { useSectionCollapsed } from "./sectionPrefs";

/**
 * The people the account follows who have this anime: status, progress, score (in this account's
 * format) and notes. Hidden while signed out or when nobody has it. Kept in memory by the backend for a
 * few minutes, never stored.
 */
export const FollowingSection: React.FC<{ anime: AnimeEntry }> = ({ anime }) => {
  const showToast = useToast();
  const scoreFormat = useScoreFormat();
  const now = useNow(60_000);
  const [page, setPage] = useState<FollowingPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [openNotes, setOpenNotes] = useState<Set<number>>(new Set());
  const mediaId = anime.anilist_id ?? anime.id;
  const collapsed = useSectionCollapsed("following");

  const load = (refresh: boolean) => {
    setLoading(true);
    toraApi
      .getFollowingEntries(mediaId, refresh)
      .then(setPage)
      .catch((e) => log.warn("anime", "Failed to load followed users' entries", e))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    setPage(null);
    setOpenNotes(new Set());
  }, [mediaId]);

  // Fetched once the section is open (collapsed: no request)
  useEffect(() => {
    if (!collapsed) load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaId, collapsed]);

  const title = (
    <>
      <UserCheck className="w-4 h-4 text-accent" />
      Following
      {page && (
        <span className="text-[11px] font-medium text-text-muted">
          {page.entries.length}
          {page.has_more ? "+" : ""}
        </span>
      )}
    </>
  );
  if (collapsed) return <PageSection id="following" title={title}>{null}</PageSection>;
  if (!page || page.entries.length === 0) return null;

  const toggleNote = (userId: number) =>
    setOpenNotes((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });

  return (
    <PageSection
      id="following"
      title={title}
      aside={
        <button
          onClick={() => load(true)}
          disabled={loading}
          title="Refresh"
          className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      }
    >
      <div className="space-y-1">
        {page.entries.map((e) => {
          const status = STATUS_INFO[e.status];
          const noteOpen = openNotes.has(e.user_id);
          const score = e.score > 0 ? formatScore(e.score, scoreFormat) : null;
          return (
            <div key={e.user_id} className="rounded-lg hover:bg-bg-tertiary/50 transition">
              <div className="flex items-center gap-2 px-1.5 py-1.5 min-w-0">
                <button
                  onClick={() => openExternal(`https://anilist.co/user/${encodeURIComponent(e.user_name)}`, showToast)}
                  title={`${e.user_name} on AniList`}
                  className="flex items-center gap-2 min-w-0 flex-1 text-left group"
                >
                  <div className="w-7 h-7 rounded-full overflow-hidden bg-bg-tertiary shrink-0">
                    {e.avatar && <img src={e.avatar} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />}
                  </div>
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold text-text-primary truncate group-hover:text-accent">
                      {e.user_name}
                    </span>
                    {e.updated_at && (
                      <span className="block text-[10px] text-text-muted">{formatRelativeTime(e.updated_at, now, "short")}</span>
                    )}
                  </span>
                </button>
                {status && (
                  <span className={`px-1.5 py-px rounded text-[10px] font-semibold shrink-0 ${status.badge}`}>
                    {status.shortLabel}
                  </span>
                )}
                <span className="w-12 text-right text-[11px] font-mono text-text-secondary shrink-0" title="Progress">
                  {e.status === "COMPLETED" && !e.repeat ? "" : `${e.progress}/${anime.episodes ?? "?"}`}
                </span>
                <span className="w-10 text-right text-[11px] font-semibold text-amber-400 shrink-0" title="Score">
                  {score ?? ""}
                </span>
                <button
                  onClick={() => e.notes && toggleNote(e.user_id)}
                  disabled={!e.notes}
                  title={e.notes ?? undefined}
                  className={`p-1 rounded shrink-0 transition ${
                    e.notes ? (noteOpen ? "text-accent" : "text-text-secondary hover:text-accent") : "invisible"
                  }`}
                >
                  <StickyNote className="w-3.5 h-3.5" />
                </button>
              </div>
              {noteOpen && e.notes && (
                <p className="px-11 pb-2 text-[11px] text-text-secondary whitespace-pre-line break-words">{e.notes}</p>
              )}
            </div>
          );
        })}
      </div>
      {page.has_more && (
        <button
          onClick={() => openExternal(anilistAnimeUrl(anime), showToast)}
          className="flex items-center gap-1 text-[11px] font-semibold text-text-secondary hover:text-accent"
        >
          <ExternalLink className="w-3 h-3" />
          More on AniList
        </button>
      )}
    </PageSection>
  );
};
