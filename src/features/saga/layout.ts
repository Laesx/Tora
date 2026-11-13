import type { SagaEdge, SagaGraph, SagaLinkKind, SagaNode } from "@/lib/types";

/**
 * Where every card and line of the saga board goes. Pure geometry over the lines the backend ordered
 * (`sync/saga.rs`): each line's columns (a main anime and the anime hanging off it) flow in snake rows
 * (left → right, then right → left…), with as many per row as makes the board closest to the viewport's
 * shape; lines are stacked. Story order keeps the backend's prequel → sequel order, release order sorts
 * the same columns by air date. Every card has the same fixed size, so nothing is measured.
 */

export type SagaOrder = "story" | "release";

export const CARD_W = 224;
export const CARD_H = 88;
export const MORE_TILE_H = 26;
const SAT_GAP = 10;
/** Satellites sit this far right of their column's main anime (the comb line runs in the gap) */
const SAT_INDENT = 20;
const COL_W = CARD_W + SAT_INDENT;
const COL_GAP = 48;
const ROW_GAP = 64;
const MARGIN = 48;
/** Room for the U-turn outside the outermost columns */
const TURN_OUT = 24;
const BLOCK_GAP = 56;
const BLOCK_HEADER = 40;
/** Satellites shown under a column until it is expanded */
export const MAX_SATELLITES = 4;

export interface LayoutCard {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Position in the line, in the order shown */
  badge?: number;
  satellite: boolean;
  /** The main anime of this card's column */
  head: number;
}

export interface LayoutMore {
  head: number;
  x: number;
  y: number;
  w: number;
  count: number;
  expanded: boolean;
}

export type PathRole = "snake" | "comb" | "link";

export interface LayoutPath {
  d: string;
  /** "then": the next one in order, with no prequel / sequel link between them */
  kind: SagaLinkKind | "then";
  role: PathRole;
  ids: [number, number];
  arrow: boolean;
}

export interface LayoutBlock {
  /** Line index (0 = the main line: no heading) */
  index: number;
  y: number;
}

export interface LayoutYear {
  x: number;
  y: number;
  year: number;
}

export interface SagaLayout {
  cards: LayoutCard[];
  more: LayoutMore[];
  paths: LayoutPath[];
  blocks: LayoutBlock[];
  years: LayoutYear[];
  width: number;
  height: number;
}

export interface LayoutInput {
  graph: SagaGraph;
  order: SagaOrder;
  /** Formats filtered out (the root always shows) */
  isVisible: (node: SagaNode) => boolean;
  /** Viewport width / height */
  aspect: number;
  /** Columns (by their backend head) whose satellites are all shown */
  expanded: Set<number>;
}

/** Key of the link between two anime */
export const edgeKey = (x: number, y: number) => (x < y ? `${x}-${y}` : `${y}-${x}`);

/** Sortable start date (`YYYYMMDD`, unknown parts 0); unknown dates last. Same as the backend's. */
export function dateNum(node: SagaNode | undefined): number {
  const parts = node?.start_date?.split("-").map((p) => parseInt(p, 10) || 0) ?? [];
  if (parts[0] > 0) return Math.min(parts[0], 9999) * 10_000 + (parts[1] ?? 0) * 100 + (parts[2] ?? 0);
  const year = node?.media.year;
  return year ? Math.min(year, 9999) * 10_000 : Number.MAX_SAFE_INTEGER;
}

const yearOf = (node: SagaNode | undefined) => {
  const n = dateNum(node);
  return n === Number.MAX_SAFE_INTEGER ? null : Math.floor(n / 10_000);
};

/** One column of a row: a main anime and the anime hanging off it. */
interface Unit {
  head: number;
  /** The backend column it comes from (expansion is keyed by it) */
  key: number;
  badge?: number;
  satellites: number[];
  hidden: number;
  expandable: boolean;
  height: number;
}

const unitHeight = (satellites: number, more: boolean) =>
  CARD_H + satellites * (CARD_H + SAT_GAP) + (more ? SAT_GAP + MORE_TILE_H : 0);

function unitsOf(input: LayoutInput, line: number, nodes: Map<number, SagaNode>, visible: (id: number) => boolean): Unit[] {
  const units: Unit[] = [];
  for (const col of input.graph.lines[line].columns) {
    const sats = col.satellites.filter(visible);
    let head: number | null = visible(col.head) ? col.head : null;
    // A filtered-out main anime: its first satellite takes the column's place
    if (head === null) {
      if (sats.length === 0) continue;
      head = sats.shift()!;
    }
    const expanded = input.expanded.has(col.head);
    const shown = expanded ? sats : sats.slice(0, MAX_SATELLITES);
    const expandable = sats.length > MAX_SATELLITES;
    units.push({
      head,
      key: col.head,
      satellites: shown,
      hidden: sats.length - shown.length,
      expandable,
      height: unitHeight(shown.length, expandable),
    });
  }
  if (input.order === "release") {
    units.sort((a, b) => dateNum(nodes.get(a.head)) - dateNum(nodes.get(b.head)) || a.head - b.head);
  }
  units.forEach((u, i) => (u.badge = i + 1));
  return units;
}

/** Rows of `perRow` units: their heights. */
function rowHeights(units: Unit[], perRow: number): number[] {
  const rows: number[] = [];
  for (let i = 0; i < units.length; i += perRow) {
    rows.push(Math.max(...units.slice(i, i + perRow).map((u) => u.height)));
  }
  return rows;
}

const blockHeight = (units: Unit[], perRow: number) => {
  const rows = rowHeights(units, perRow);
  return rows.reduce((a, b) => a + b, 0) + Math.max(0, rows.length - 1) * ROW_GAP;
};

const boardWidth = (perRow: number) => 2 * MARGIN + perRow * COL_W + (perRow - 1) * COL_GAP;

/** Bezier between the facing sides of two cards. */
function curve(a: LayoutCard, b: LayoutCard): string {
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2;
  const by = b.y + b.h / 2;
  if (Math.abs(bx - ax) >= Math.abs(by - ay)) {
    const dir = bx > ax ? 1 : -1;
    const x1 = dir > 0 ? a.x + a.w : a.x;
    const x2 = dir > 0 ? b.x : b.x + b.w;
    const c = Math.max(36, Math.abs(x2 - x1) / 2) * dir;
    return `M${x1},${ay} C${x1 + c},${ay} ${x2 - c},${by} ${x2},${by}`;
  }
  const dir = by > ay ? 1 : -1;
  const y1 = dir > 0 ? a.y + a.h : a.y;
  const y2 = dir > 0 ? b.y : b.y + b.h;
  const c = Math.max(36, Math.abs(y2 - y1) / 2) * dir;
  return `M${ax},${y1} C${ax},${y1 + c} ${bx},${y2 - c} ${bx},${y2}`;
}

export function layoutSaga(input: LayoutInput): SagaLayout {
  const { graph } = input;
  const nodes = new Map(graph.nodes.map((n) => [n.media.id, n]));
  const edges = new Map<string, SagaEdge>(graph.edges.map((e) => [edgeKey(e.a, e.b), e]));
  const visible = (id: number) => {
    const node = nodes.get(id);
    return id === graph.root || (node !== undefined && input.isVisible(node));
  };
  const lineUnits = graph.lines.map((_, i) => unitsOf(input, i, nodes, visible));
  const shownLines = lineUnits.filter((u) => u.length > 0);
  const maxUnits = Math.max(1, ...shownLines.map((u) => u.length));

  // As many columns per row as makes the board's shape closest to the viewport's
  const target = Math.log(Math.max(0.2, input.aspect));
  let perRow = 1;
  let best = Infinity;
  for (let k = 1; k <= maxUnits; k++) {
    const height =
      2 * MARGIN + shownLines.reduce((sum, u, i) => sum + blockHeight(u, k) + (i > 0 ? BLOCK_GAP + BLOCK_HEADER : 0), 0);
    const score = Math.abs(Math.log(boardWidth(k) / Math.max(1, height)) - target);
    if (score < best - 1e-9) {
      best = score;
      perRow = k;
    }
  }

  const cards: LayoutCard[] = [];
  const more: LayoutMore[] = [];
  const paths: LayoutPath[] = [];
  const blocks: LayoutBlock[] = [];
  const years: LayoutYear[] = [];
  const cardOf = new Map<number, LayoutCard>();
  const drawn = new Set<string>();
  let y = MARGIN;

  lineUnits.forEach((units, index) => {
    if (units.length === 0) return;
    if (blocks.length > 0) y += BLOCK_GAP + BLOCK_HEADER;
    blocks.push({ index, y: y - BLOCK_HEADER });
    const rows = rowHeights(units, perRow);
    const heads: LayoutCard[] = [];
    let lastYear: number | null = null;
    rows.forEach((rowH, r) => {
      const leftToRight = r % 2 === 0;
      units.slice(r * perRow, (r + 1) * perRow).forEach((u, j) => {
        const slot = leftToRight ? j : perRow - 1 - j;
        const x = MARGIN + slot * (COL_W + COL_GAP);
        const head: LayoutCard = { id: u.head, x, y, w: CARD_W, h: CARD_H, badge: u.badge, satellite: false, head: u.head };
        cards.push(head);
        cardOf.set(head.id, head);
        heads.push(head);
        if (input.order === "release") {
          const year = yearOf(nodes.get(head.id));
          if (year !== null && year !== lastYear) years.push({ x, y: y - 20, year });
          if (year !== null) lastYear = year;
        }
        let sy = y + CARD_H + SAT_GAP;
        for (const s of u.satellites) {
          const card: LayoutCard = { id: s, x: x + SAT_INDENT, y: sy, w: CARD_W, h: CARD_H, satellite: true, head: u.head };
          cards.push(card);
          cardOf.set(s, card);
          // Comb: down the column's left side, a tick into each satellite
          const anchor = edges.has(edgeKey(u.head, s))
            ? u.head
            : u.satellites.find((o) => o !== s && edges.has(edgeKey(o, s))) ?? u.head;
          const edge = edges.get(edgeKey(anchor, s));
          if (edge) drawn.add(edgeKey(anchor, s));
          paths.push({
            d: `M${x + 9},${y + CARD_H} V${sy + CARD_H / 2} H${x + SAT_INDENT}`,
            kind: edge?.kind ?? "then",
            role: "comb",
            ids: [anchor, s],
            arrow: false,
          });
          sy += CARD_H + SAT_GAP;
        }
        if (u.expandable) {
          more.push({ head: u.key, x: x + SAT_INDENT, y: sy, w: CARD_W, count: u.hidden, expanded: u.hidden === 0 });
        }
      });
      y += rowH + ROW_GAP;
    });
    y -= ROW_GAP;

    // Snake: each column to the next, straight within a row, a U-turn outside the columns between rows
    for (let i = 0; i + 1 < heads.length; i++) {
      const a = heads[i];
      const b = heads[i + 1];
      const edge = edges.get(edgeKey(a.id, b.id));
      const chain = edge?.kind === "chain";
      if (chain) drawn.add(edgeKey(a.id, b.id));
      const ay = a.y + CARD_H / 2;
      const by = b.y + CARD_H / 2;
      let d: string;
      if (Math.abs(a.y - b.y) < 1) {
        d = a.x < b.x ? `M${a.x + a.w},${ay} H${b.x}` : `M${a.x},${ay} H${b.x + b.w}`;
      } else {
        const rightSide = Math.floor(i / perRow) % 2 === 0;
        const out = rightSide ? a.x + COL_W + TURN_OUT : a.x - TURN_OUT;
        const r = 14;
        const turn = rightSide ? 1 : -1;
        d =
          `M${rightSide ? a.x + a.w : a.x},${ay} H${out - r * turn} Q${out},${ay} ${out},${ay + r} ` +
          `V${by - r} Q${out},${by} ${out - r * turn},${by} H${rightSide ? b.x + b.w : b.x}`;
      }
      paths.push({ d, kind: chain ? "chain" : "then", role: "snake", ids: [a.id, b.id], arrow: true });
    }
  });

  // Every other link between two cards on the board
  for (const e of graph.edges) {
    const key = edgeKey(e.a, e.b);
    const a = cardOf.get(e.a);
    const b = cardOf.get(e.b);
    if (drawn.has(key) || !a || !b) continue;
    paths.push({ d: curve(a, b), kind: e.kind, role: "link", ids: [e.a, e.b], arrow: false });
  }

  return { cards, more, paths, blocks, years, width: boardWidth(perRow), height: y + MARGIN };
}
