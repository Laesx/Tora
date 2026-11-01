import { useCallback, useRef } from "react";
import type { Dispatch, MouseEvent, SetStateAction } from "react";

/**
 * Click selection over a list in display order: a plain click selects one, Ctrl toggles, Shift
 * selects the range from the last clicked (Ctrl+Shift adds it to the selection).
 */
export function useClickSelection(
  items: { id: number }[],
  setSelectedIds: Dispatch<SetStateAction<number[]>>
) {
  const lastClickedIdRef = useRef<number | null>(null);

  const click = useCallback(
    (e: MouseEvent, id: number) => {
      const isCtrlOrCmd = e.ctrlKey || e.metaKey;

      if (e.shiftKey && lastClickedIdRef.current !== null) {
        const startIdx = items.findIndex((a) => a.id === lastClickedIdRef.current);
        const endIdx = items.findIndex((a) => a.id === id);
        if (startIdx !== -1 && endIdx !== -1) {
          const low = Math.min(startIdx, endIdx);
          const high = Math.max(startIdx, endIdx);
          const rangeIds = items.slice(low, high + 1).map((a) => a.id);
          setSelectedIds((prev) =>
            isCtrlOrCmd ? Array.from(new Set([...prev, ...rangeIds])) : rangeIds
          );
          return;
        }
      }

      if (isCtrlOrCmd) {
        setSelectedIds((prev) =>
          prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
        );
      } else {
        setSelectedIds([id]);
      }
      lastClickedIdRef.current = id;
    },
    [items, setSelectedIds]
  );

  return { click, lastClickedIdRef };
}
