import { useCallback, useEffect, useRef, useState } from "react";
import { AnimePageData, AnimePageRequest } from "@/lib/types";
import { toraApi } from "@/lib/api";
import { log } from "@/lib/log";
import { pinnedUsers } from "./followingPins";

/** Identical requests share one call (React runs effects twice in development). */
const inFlight = new Map<string, Promise<AnimePageData>>();

function fetchPage(mediaId: number, request: AnimePageRequest): Promise<AnimePageData> {
  const key = JSON.stringify([mediaId, request]);
  let call = inFlight.get(key);
  if (!call) {
    call = toraApi.getAnimePage(mediaId, request).finally(() => inFlight.delete(key));
    inFlight.set(key, call);
  }
  return call;
}

/**
 * The anime page's data in one backend call: stored metadata and details while fresh, else one AniList
 * request for whatever is missing. Open sections decide what's wanted: Recommendations and Following
 * are only fetched once open. The backend serializes calls, so each answer holds everything before it.
 */
export function useAnimePageData(mediaId: number, open: { recommendations: boolean; following: boolean }) {
  const [data, setData] = useState<AnimePageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState<"details" | "following" | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const idRef = useRef(mediaId);
  idRef.current = mediaId;
  const seq = useRef(0);
  const moreInFlight = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;

  const load = useCallback(
    (refresh: "details" | "following" | null) => {
      const id = mediaId;
      const mine = ++seq.current;
      const { recommendations, following } = openRef.current;
      const request: AnimePageRequest = {
        recommendations,
        following,
        refresh_details: refresh === "details",
        refresh_following: refresh === "following",
        pinned_users: following ? pinnedUsers() : [],
      };
      setLoading(true);
      if (refresh) setRefreshing(refresh);
      fetchPage(id, request)
        .then((d) => {
          if (idRef.current === id && seq.current === mine) setData(d);
        })
        .catch((e) => {
          log.warn("anime", "Failed to load the anime page", e);
          if (idRef.current === id && seq.current === mine)
            setData((prev) => (prev ? { ...prev, error: String(e) } : null));
        })
        .finally(() => {
          if (idRef.current === id && seq.current === mine) {
            setLoading(false);
            setRefreshing(null);
          }
        });
    },
    [mediaId]
  );

  useEffect(() => {
    setData(null);
  }, [mediaId]);

  // Again when a section opens: the backend fetches only what that section adds
  useEffect(() => {
    load(null);
  }, [load, open.recommendations, open.following]);

  const loadMoreCharacters = useCallback(() => {
    if (moreInFlight.current) return;
    moreInFlight.current = true;
    setLoadingMore(true);
    const id = mediaId;
    toraApi
      .loadMoreCharacters(id)
      .then((details) => {
        if (idRef.current === id) setData((prev) => (prev ? { ...prev, details } : prev));
      })
      .catch((e) => log.warn("anime", "Failed to load more characters", e))
      .finally(() => {
        moreInFlight.current = false;
        if (idRef.current === id) setLoadingMore(false);
      });
  }, [mediaId]);

  return {
    data,
    loading,
    refreshing,
    loadingMore,
    refreshDetails: () => load("details"),
    refreshFollowing: () => load("following"),
    loadMoreCharacters,
  };
}
