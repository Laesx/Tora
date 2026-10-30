import { useCallback, useMemo } from "react";
import { usePrefs } from "@/hooks/usePrefs";
import type { WatchlistSortKey } from "./sort";

export type TableColumnId = "title" | "format" | "progress" | "season" | "updated";

export interface TableColumn {
  id: TableColumnId;
  label: string;
  /** Header click sorts by this key */
  sortKey: WatchlistSortKey | null;
  /** `null` = takes the remaining width (the title); never hidden, and resized only through its neighbour */
  defaultWidth: number | null;
  minWidth: number;
  hideable: boolean;
  /** Its left edge (the boundary with the previous column) can be dragged */
  resizable: boolean;
  /** Header cell padding / alignment (body cells match) */
  className: string;
}

/**
 * Table columns in display order. Widths are fixed (`table-fixed`) so rows never change height. The
 * title fills what is left, so the columns after it are anchored to the table's right edge: a
 * boundary is dragged by resizing the column on its right.
 */
export const TABLE_COLUMNS: TableColumn[] = [
  { id: "title", label: "Anime Title", sortKey: "title", defaultWidth: null, minWidth: 180, hideable: false, resizable: false, className: "pl-4 pr-3" },
  { id: "format", label: "Type", sortKey: "format", defaultWidth: 84, minWidth: 56, hideable: true, resizable: true, className: "px-3" },
  { id: "progress", label: "Progress", sortKey: "progress", defaultWidth: 210, minWidth: 140, hideable: true, resizable: true, className: "px-3" },
  { id: "season", label: "Season", sortKey: "season", defaultWidth: 116, minWidth: 64, hideable: true, resizable: true, className: "px-3" },
  { id: "updated", label: "Updated", sortKey: "updated", defaultWidth: 124, minWidth: 72, hideable: true, resizable: true, className: "px-3" },
];

const COLUMNS_BY_ID = new Map(TABLE_COLUMNS.map((c) => [c.id, c]));
const MAX_COLUMN_WIDTH = 600;

interface TableColumnPrefs {
  /** User widths by column id (missing = default) */
  widths: Partial<Record<TableColumnId, number>>;
  hidden: TableColumnId[];
}

const DEFAULT_PREFS: TableColumnPrefs = { widths: {}, hidden: [] };

export const clampColumnWidth = (column: TableColumn, width: number) =>
  Math.round(Math.max(column.minWidth, Math.min(MAX_COLUMN_WIDTH, width)));

/** Drops unknown / no longer resizable or hideable columns and bad widths from stored prefs. */
function migrateColumnPrefs(prefs: TableColumnPrefs): TableColumnPrefs {
  const widths: TableColumnPrefs["widths"] = {};
  for (const [id, width] of Object.entries(prefs.widths ?? {})) {
    const column = COLUMNS_BY_ID.get(id as TableColumnId);
    if (column?.resizable && typeof width === "number" && Number.isFinite(width)) {
      widths[column.id] = clampColumnWidth(column, width);
    }
  }
  const hidden = Array.isArray(prefs.hidden)
    ? prefs.hidden.filter((id) => COLUMNS_BY_ID.get(id)?.hideable)
    : [];
  return { widths, hidden };
}

/** Table column widths and visibility, per device (`tora.watchlist.columns`). */
export function useTableColumns() {
  const [prefs, updatePrefs] = usePrefs<TableColumnPrefs>("tora.watchlist.columns", DEFAULT_PREFS, migrateColumnPrefs);

  const columns = useMemo(
    () => TABLE_COLUMNS.filter((c) => !prefs.hidden.includes(c.id)),
    [prefs.hidden]
  );

  const widthOf = useCallback(
    (column: TableColumn) => (column.defaultWidth === null ? null : prefs.widths[column.id] ?? column.defaultWidth),
    [prefs.widths]
  );

  const setWidth = useCallback(
    (column: TableColumn, width: number | null) => {
      const widths = { ...prefs.widths };
      if (width === null) delete widths[column.id];
      else widths[column.id] = clampColumnWidth(column, width);
      updatePrefs({ widths });
    },
    [prefs.widths, updatePrefs]
  );

  const toggleHidden = useCallback(
    (column: TableColumn) => {
      if (!column.hideable) return;
      updatePrefs({
        hidden: prefs.hidden.includes(column.id)
          ? prefs.hidden.filter((id) => id !== column.id)
          : [...prefs.hidden, column.id],
      });
    },
    [prefs.hidden, updatePrefs]
  );

  const reset = useCallback(() => updatePrefs(DEFAULT_PREFS), [updatePrefs]);

  const isCustomized = prefs.hidden.length > 0 || Object.keys(prefs.widths).length > 0;

  return { columns, hidden: prefs.hidden, widthOf, setWidth, toggleHidden, reset, isCustomized };
}
