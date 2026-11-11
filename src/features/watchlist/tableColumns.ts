import { useCallback, useMemo } from "react";
import { usePrefs } from "@/hooks/usePrefs";
import type { WatchlistSortKey } from "./sort";

export type TableColumnId =
  | "title"
  | "format"
  | "progress"
  | "score"
  | "average_score"
  | "season"
  | "started"
  | "completed"
  | "next_airing"
  | "ready"
  | "time_left"
  | "notes"
  | "updated";

export interface TableColumn {
  id: TableColumnId;
  label: string;
  /** Header click sorts by this key */
  sortKey: WatchlistSortKey | null;
  /** `null` = takes the remaining width (the title); never hidden, and resized only through its neighbour */
  defaultWidth: number | null;
  minWidth: number;
  hideable: boolean;
  /** Its boundary with the neighbour away from the title can be dragged */
  resizable: boolean;
  /** Hidden until turned on from the header's right-click menu */
  defaultHidden?: boolean;
  /** Header cell padding / alignment (body cells match) */
  className: string;
}

/**
 * Table columns in default order. Widths are fixed (`table-fixed`) so rows never change height. The
 * title fills what is left, so the columns after it are anchored to the table's right edge and the
 * ones before it to the left: a boundary is dragged by resizing the column on its side away from
 * the title.
 */
export const TABLE_COLUMNS: TableColumn[] = [
  { id: "title", label: "Anime Title", sortKey: "title", defaultWidth: null, minWidth: 180, hideable: false, resizable: false, className: "pl-4 pr-3" },
  { id: "format", label: "Type", sortKey: "format", defaultWidth: 84, minWidth: 56, hideable: true, resizable: true, className: "px-3" },
  { id: "progress", label: "Progress", sortKey: "progress", defaultWidth: 210, minWidth: 140, hideable: true, resizable: true, className: "px-3" },
  { id: "score", label: "Score", sortKey: "score", defaultWidth: 72, minWidth: 56, hideable: true, resizable: true, className: "px-3" },
  { id: "average_score", label: "Avg", sortKey: "average_score", defaultWidth: 72, minWidth: 52, hideable: true, resizable: true, className: "px-3" },
  { id: "season", label: "Season", sortKey: "season", defaultWidth: 116, minWidth: 64, hideable: true, resizable: true, className: "px-3" },
  { id: "started", label: "Started", sortKey: "started", defaultWidth: 104, minWidth: 72, hideable: true, resizable: true, defaultHidden: true, className: "px-3" },
  { id: "completed", label: "Completed", sortKey: "completed", defaultWidth: 104, minWidth: 72, hideable: true, resizable: true, defaultHidden: true, className: "px-3" },
  { id: "next_airing", label: "Next ep", sortKey: "next_airing", defaultWidth: 132, minWidth: 80, hideable: true, resizable: true, defaultHidden: true, className: "px-3" },
  { id: "ready", label: "On disk", sortKey: "ready", defaultWidth: 84, minWidth: 56, hideable: true, resizable: true, defaultHidden: true, className: "px-3" },
  { id: "time_left", label: "Time left", sortKey: "time_left", defaultWidth: 88, minWidth: 60, hideable: true, resizable: true, defaultHidden: true, className: "px-3" },
  { id: "notes", label: "Notes", sortKey: "notes", defaultWidth: 180, minWidth: 80, hideable: true, resizable: true, defaultHidden: true, className: "px-3" },
  { id: "updated", label: "Updated", sortKey: "updated", defaultWidth: 124, minWidth: 72, hideable: true, resizable: true, className: "px-3" },
];

const COLUMNS_BY_ID = new Map(TABLE_COLUMNS.map((c) => [c.id, c]));
const DEFAULT_ORDER = TABLE_COLUMNS.map((c) => c.id);
const MAX_COLUMN_WIDTH = 600;

interface TableColumnPrefs {
  /** Every column id in display order (hidden ones included) */
  order: TableColumnId[];
  /** User widths by column id (missing = default) */
  widths: Partial<Record<TableColumnId, number>>;
  /** Shown / hidden by the user (missing = `!defaultHidden`) */
  visibility: Partial<Record<TableColumnId, boolean>>;
}

/** Older prefs kept the hidden columns as a list */
type StoredColumnPrefs = TableColumnPrefs & { hidden?: unknown };

const DEFAULT_PREFS: TableColumnPrefs = { order: DEFAULT_ORDER, widths: {}, visibility: {} };

export const clampColumnWidth = (column: TableColumn, width: number) =>
  Math.round(Math.max(column.minWidth, Math.min(MAX_COLUMN_WIDTH, width)));

const isShown = (column: TableColumn, visibility: TableColumnPrefs["visibility"]) =>
  !column.hideable || (visibility[column.id] ?? !column.defaultHidden);

/** Known ids in the stored order; columns it lacks go right after their default predecessor. */
function migrateOrder(stored: unknown): TableColumnId[] {
  const order: TableColumnId[] = [];
  if (Array.isArray(stored)) {
    for (const id of stored) {
      if (COLUMNS_BY_ID.has(id) && !order.includes(id)) order.push(id);
    }
  }
  DEFAULT_ORDER.forEach((id, i) => {
    if (order.includes(id)) return;
    const after = i === 0 ? -1 : order.indexOf(DEFAULT_ORDER[i - 1]);
    order.splice(after + 1, 0, id);
  });
  return order;
}

/** Drops unknown / no longer resizable or hideable columns and bad widths from stored prefs. */
function migrateColumnPrefs(prefs: StoredColumnPrefs): TableColumnPrefs {
  const widths: TableColumnPrefs["widths"] = {};
  for (const [id, width] of Object.entries(prefs.widths ?? {})) {
    const column = COLUMNS_BY_ID.get(id as TableColumnId);
    if (column?.resizable && typeof width === "number" && Number.isFinite(width)) {
      widths[column.id] = clampColumnWidth(column, width);
    }
  }
  const visibility: TableColumnPrefs["visibility"] = {};
  if (Array.isArray(prefs.hidden)) {
    for (const id of prefs.hidden) {
      if (COLUMNS_BY_ID.get(id)?.hideable) visibility[id as TableColumnId] = false;
    }
  }
  for (const [id, shown] of Object.entries(prefs.visibility ?? {})) {
    if (COLUMNS_BY_ID.get(id as TableColumnId)?.hideable && typeof shown === "boolean") {
      visibility[id as TableColumnId] = shown;
    }
  }
  return { order: migrateOrder(prefs.order), widths, visibility };
}

/** Table column order, widths and visibility, per device (`tora.watchlist.columns`). */
export function useTableColumns() {
  const [prefs, updatePrefs] = usePrefs<StoredColumnPrefs>("tora.watchlist.columns", DEFAULT_PREFS, migrateColumnPrefs);

  /** Every column in display order */
  const ordered = useMemo(() => prefs.order.map((id) => COLUMNS_BY_ID.get(id)!), [prefs.order]);

  /** The shown columns in display order */
  const columns = useMemo(
    () => ordered.filter((c) => isShown(c, prefs.visibility)),
    [ordered, prefs.visibility]
  );

  const isVisible = useCallback((column: TableColumn) => isShown(column, prefs.visibility), [prefs.visibility]);

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
      const visibility = { ...prefs.visibility };
      const shown = !isShown(column, prefs.visibility);
      // Back to its default: forget the override
      if (shown === !column.defaultHidden) delete visibility[column.id];
      else visibility[column.id] = shown;
      updatePrefs({ visibility });
    },
    [prefs.visibility, updatePrefs]
  );

  /** Moves `id` so it lands right before `beforeId` (`null` = the end), among all columns. */
  const move = useCallback(
    (id: TableColumnId, beforeId: TableColumnId | null) => {
      if (id === beforeId) return;
      const order = prefs.order.filter((c) => c !== id);
      const at = beforeId === null ? order.length : order.indexOf(beforeId);
      order.splice(at < 0 ? order.length : at, 0, id);
      if (order.some((c, i) => c !== prefs.order[i])) updatePrefs({ order });
    },
    [prefs.order, updatePrefs]
  );

  const reset = useCallback(() => updatePrefs(DEFAULT_PREFS), [updatePrefs]);

  const isCustomized =
    Object.keys(prefs.visibility).length > 0 ||
    Object.keys(prefs.widths).length > 0 ||
    prefs.order.some((id, i) => id !== DEFAULT_ORDER[i]);

  return { columns, ordered, isVisible, widthOf, setWidth, toggleHidden, move, reset, isCustomized };
}
