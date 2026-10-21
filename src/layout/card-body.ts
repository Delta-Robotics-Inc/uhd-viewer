/**
 * What a module card's body holds (its icon, its title and the chips that
 * count its unlinked interfaces by protocol) and how much height that needs.
 *
 * The layout grows a card to fit its body between the labels of the ports
 * on its top and bottom edges; the card then draws only the chips that fit
 * and folds the rest into "+N". Sizes follow `.module-body`, `.module-title`
 * and `.port-group` in styles/app.css.
 */
import type { PortGroup } from "./layout";
import type { Side } from "../canvas/routing";

const BORDER = 2;
const PAD_X = 34;
const ICON = 22;
const GAP = 7;
const TITLE_LINE = 13;
const TITLE_CHAR = 6.4;
/** Room kept above and below the body: a port label's row on an edge with labelled ports, else a margin. */
const EDGE = 8;
const LABEL_ROW = 20;
/** A side label: its offset from the edge, its width per character (8 px type), and the gap kept beside it. */
const LABEL_OFFSET = 9;
const LABEL_CHAR = 4.9;
const LABEL_GAP = 4;
const CHIP_H = 14;
const CHIP_GAP = 3;
const CHIP_CHAR = 4.9;
const CHIP_PAD = 12;
/** Chips shown before the rest fold into "+N". */
export const MAX_CHIPS = 4;
/** Chip rows a card grows for; more chips fold into "+N". */
export const MAX_CHIP_ROWS = 3;

export interface CardInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** A port's label as the card draws it: the name without its parenthesised or dashed qualifier. */
export function portLabelText(name: string): string {
  return name.replace(/\s*\(.*?\)/g, "").replace(/\s+[—–-]\s+.*$/, "");
}

/** How wide a label on a card's left or right edge may run before it is cut with an ellipsis. */
export function sideLabelWidth(cardWidth: number): number {
  return Math.max(40, cardWidth / 2 - 54);
}

/** A card's width with nothing to fit, and the widest it grows to for its labels. */
export const CARD_W = 170;
export const CARD_W_MAX = 272;

/** The widest a label on a card's top or bottom edge runs (its share of the edge, when that is less). */
export const TOP_LABEL_MAX = 160;

/** A label's width as drawn (8 px type). */
export const labelWidth = (name: string): number => Math.ceil(portLabelText(name).length * LABEL_CHAR);

/**
 * The width a card takes so the labels of its linked interfaces fit beside
 * its body: as wide as the longest needs (two may face each other across the
 * card), from the plain width up to `CARD_W_MAX`. A longer label is cut with
 * an ellipsis and says its whole name on hover.
 */
export function cardWidth(labels: readonly string[]): number {
  const widest = Math.max(0, ...labels.map(labelWidth));
  // the inverse of sideLabelWidth, with a pixel to spare for the ellipsis rule
  const need = 2 * (widest + 1 + 54);
  return Math.min(CARD_W_MAX, Math.max(CARD_W, need));
}

/** A label is drawn short: it does not fit `width`, or the card leaves out the name's qualifier. */
export function labelIsCut(name: string, width: number): boolean {
  return portLabelText(name) !== name || labelWidth(name) > width;
}

/**
 * Room the body keeps clear of the port labels: a label row on the top and
 * bottom edges that have labelled ports, and on the left and right as wide
 * as that edge's longest label.
 */
export function cardInsets(labels: { side: Side; name: string }[], cardWidth: number): CardInsets {
  const has = (side: Side) => labels.some((l) => l.side === side);
  const across = (side: Side) => {
    const widest = Math.max(0, ...labels.filter((l) => l.side === side).map((l) => portLabelText(l.name).length * LABEL_CHAR));
    return widest ? Math.max(PAD_X, LABEL_OFFSET + Math.min(sideLabelWidth(cardWidth), widest) + LABEL_GAP) : PAD_X;
  };
  return { top: has("top") ? LABEL_ROW : EDGE, bottom: has("bottom") ? LABEL_ROW : EDGE, left: across("left"), right: across("right") };
}

export function chipText(g: PortGroup): string {
  return `${g.protocol.replace(/_/g, " ").toUpperCase()} ×${g.count}`;
}

const chipWidth = (text: string) => text.length * CHIP_CHAR + CHIP_PAD;

/** Rows the chips wrap to in a body `width` wide (flex-wrap, centred). */
function chipRows(texts: string[], width: number): number {
  let rows = 0;
  let used = Infinity;
  for (const t of texts) {
    const w = Math.min(chipWidth(t), width);
    if (used + CHIP_GAP + w > width) {
      rows++;
      used = w;
    } else used += CHIP_GAP + w;
  }
  return rows;
}

function titleLines(title: string, bodyWidth: number): number {
  const perLine = Math.max(6, Math.floor(bodyWidth / TITLE_CHAR));
  return Math.min(3, Math.max(1, Math.ceil(title.length / perLine)));
}

/** The chips in the order drawn: the first few groups, then "+N" for the interfaces of the rest. */
function chipsFor(groups: PortGroup[], shown: number): { shown: PortGroup[]; rest: number; texts: string[] } {
  const list = groups.slice(0, shown);
  const rest = groups.slice(shown).reduce((n, g) => n + g.count, 0);
  return { shown: list, rest, texts: [...list.map(chipText), ...(rest > 0 ? [`+${rest}`] : [])] };
}

const rowsHeight = (rows: number) => (rows > 0 ? GAP + rows * CHIP_H + (rows - 1) * CHIP_GAP : 0);

/** The height a card needs for its body, with up to MAX_CHIP_ROWS rows of chips. */
export function cardHeight(title: string, width: number, groups: PortGroup[], insets: CardInsets): number {
  const body = width - insets.left - insets.right;
  const rows = groups.length ? Math.min(MAX_CHIP_ROWS, chipRows(chipsFor(groups, MAX_CHIPS).texts, body)) : 0;
  return 2 * BORDER + insets.top + insets.bottom + ICON + GAP + titleLines(title, body) * TITLE_LINE + rowsHeight(rows);
}

/**
 * The chips a card of this size draws: as many groups as fit its free rows,
 * the rest counted in "+N". A card with no room for a row draws none.
 */
export function fitChips(title: string, box: { w: number; h: number }, groups: PortGroup[], insets: CardInsets): { shown: PortGroup[]; rest: number } {
  if (!groups.length) return { shown: [], rest: 0 };
  const body = box.w - insets.left - insets.right;
  const free = box.h - 2 * BORDER - insets.top - insets.bottom - ICON - GAP - titleLines(title, body) * TITLE_LINE;
  let rows = 0;
  while (rows < MAX_CHIP_ROWS && rowsHeight(rows + 1) <= free) rows++;
  if (rows === 0) return { shown: [], rest: 0 };
  for (let k = Math.min(MAX_CHIPS, groups.length); k >= 0; k--) {
    const c = chipsFor(groups, k);
    if (chipRows(c.texts, body) <= rows) return { shown: c.shown, rest: c.rest };
  }
  return { shown: [], rest: 0 };
}
