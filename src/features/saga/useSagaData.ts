import { useCallback, useEffect, useRef, useState } from "react";
import type { SagaGraph, SagaRequest } from "@/lib/types";
import { toraApi } from "@/lib/api";
import { errorText } from "@/lib/log";

/** Calls that stopped at the request cap are continued this many times on their own, then on request. */
const AUTO_CONTINUE = 2;

/** The last saga shown: opening it again from another of its anime shows it at once */
let lastGraph: SagaGraph | null = null;
/** Identical calls in flight share one answer */
const inFlight = new Map<string, Promise<SagaGraph>>();

function fetchSaga(id: number, request: SagaRequest): Promise<SagaGraph> {
  const key = JSON.stringify([id, request]);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const call = toraApi.getSaga(id, request).finally(() => inFlight.delete(key));
  inFlight.set(key, call);
  return call;
}

/** The saga seen from `rootId`, the last one's copy when it contains that anime */
function cachedFor(rootId: number): SagaGraph | null {
  if (!lastGraph?.nodes.some((n) => n.walked && n.media.id === rootId)) return null;
  return { ...lastGraph, root: rootId };
}

/**
 * The saga graph of one anime: `get_saga` (stored rows, a request per ring only for missing or old ones).
 * A walk stopped at the request cap continues on its own a couple of times; expanded end boxes are kept
 * for the view's lifetime.
 */
export function useSagaData(rootId: number) {
  const [graph, setGraph] = useState<SagaGraph | null>(() => cachedFor(rootId));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const expandRef = useRef<number[]>([]);
  const continued = useRef(0);
  const current = useRef(0);

  const load = useCallback(
    async (refresh = false) => {
      const ticket = ++current.current;
      setLoading(true);
      setError(null);
      try {
        let result = await fetchSaga(rootId, { expand: expandRef.current, refresh });
        while (result.more && continued.current < AUTO_CONTINUE && ticket === current.current) {
          continued.current += 1;
          setGraph(result);
          result = await fetchSaga(rootId, { expand: expandRef.current });
        }
        if (ticket !== current.current) return;
        lastGraph = result;
        setGraph(result);
      } catch (e) {
        if (ticket === current.current) setError(errorText(e));
      } finally {
        if (ticket === current.current) setLoading(false);
      }
    },
    [rootId]
  );

  useEffect(() => {
    continued.current = 0;
    expandRef.current = [];
    setGraph(cachedFor(rootId));
    void load();
  }, [rootId, load]);

  return {
    graph,
    loading,
    error,
    refresh: () => {
      continued.current = 0;
      void load(true);
    },
    /** Walk an end box's links too */
    expand: (id: number) => {
      if (expandRef.current.includes(id)) return;
      expandRef.current = [...expandRef.current, id];
      void load();
    },
    /** Continue a walk that stopped at its request cap */
    loadMore: () => {
      continued.current = 0;
      void load();
    },
  };
}
