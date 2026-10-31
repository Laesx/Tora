import { useCallback, useRef, useState } from "react";
import { NavLocation, sameLocation } from "./navigation";

const MAX_ENTRIES = 10;
/** Only the newest entries keep their loaded data (History rows, search results) */
const CACHED_ENTRIES = 3;

interface Stacks {
  back: NavLocation[];
  forward: NavLocation[];
}

const trim = (list: NavLocation[]) =>
  list
    .slice(-MAX_ENTRIES)
    .map((loc, i, all) => (loc.cache && i < all.length - CACHED_ENTRIES ? { ...loc, cache: undefined } : loc));

/** `loc` on top of `list`, replacing a top entry for the same location */
const pushOnto = (list: NavLocation[], loc: NavLocation) => {
  const top = list[list.length - 1];
  return trim(top && sameLocation(top, loc) ? [...list.slice(0, -1), loc] : [...list, loc]);
};

/**
 * Back / forward stacks of `NavLocation`s, like a browser's. The caller passes the location it is
 * leaving: `push` before every jump (clears forward), `step` to go back or forward. Entries equal to
 * the current location are skipped (e.g. a drawer that was opened and closed again).
 */
export function useNavHistory() {
  const stacks = useRef<Stacks>({ back: [], forward: [] });
  const [snapshot, setSnapshot] = useState<Stacks>(stacks.current);

  const set = (next: Stacks) => {
    stacks.current = next;
    setSnapshot(next);
  };

  const push = useCallback((current: NavLocation) => {
    set({ back: pushOnto(stacks.current.back, current), forward: [] });
  }, []);

  const step = useCallback((dir: "back" | "forward", current: NavLocation): NavLocation | null => {
    const from = [...stacks.current[dir]];
    let target: NavLocation | undefined;
    while ((target = from.pop()) && sameLocation(target, current));
    if (!target) {
      if (from.length !== stacks.current[dir].length) set({ ...stacks.current, [dir]: from });
      return null;
    }
    const rest = pushOnto(stacks.current[dir === "back" ? "forward" : "back"], current);
    set(dir === "back" ? { back: from, forward: rest } : { back: rest, forward: from });
    return target;
  }, []);

  const clear = useCallback(() => set({ back: [], forward: [] }), []);
  /** Forget the newest back entry (a drawer closed again: its page is the current one) */
  const dropTop = useCallback(() => set({ ...stacks.current, back: stacks.current.back.slice(0, -1) }), []);

  return {
    back: snapshot.back,
    forward: snapshot.forward,
    push,
    step,
    clear,
    dropTop,
  };
}
