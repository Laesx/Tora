import { useCallback, useEffect, useRef, useState } from "react";
import { MediaDetails } from "@/lib/types";
import { toraApi } from "@/lib/api";
import { log } from "@/lib/log";

/**
 * The anime page's details (characters, staff, recommendations): stored ones, fetched when missing or
 * old. `loadMoreCharacters` appends the next page (one at a time); `refresh` fetches again.
 */
export function useMediaDetails(mediaId: number) {
  const [details, setDetails] = useState<MediaDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(mediaId);
  idRef.current = mediaId;
  const moreInFlight = useRef(false);

  const load = useCallback(
    (refresh: boolean) => {
      setLoading(true);
      setError(null);
      toraApi
        .getMediaDetails(mediaId, refresh)
        .then((d) => {
          if (idRef.current === mediaId) setDetails(d);
        })
        .catch((e) => {
          log.warn("anime", "Failed to load media details", e);
          if (idRef.current === mediaId) setError(String(e));
        })
        .finally(() => {
          if (idRef.current === mediaId) setLoading(false);
        });
    },
    [mediaId]
  );

  useEffect(() => {
    setDetails(null);
    load(false);
  }, [load]);

  const loadMoreCharacters = useCallback(() => {
    if (moreInFlight.current) return;
    moreInFlight.current = true;
    setLoadingMore(true);
    toraApi
      .loadMoreCharacters(mediaId)
      .then((d) => {
        if (idRef.current === mediaId) setDetails(d);
      })
      .catch((e) => log.warn("anime", "Failed to load more characters", e))
      .finally(() => {
        moreInFlight.current = false;
        if (idRef.current === mediaId) setLoadingMore(false);
      });
  }, [mediaId]);

  return { details, loading, loadingMore, error, refresh: () => load(true), loadMoreCharacters };
}
