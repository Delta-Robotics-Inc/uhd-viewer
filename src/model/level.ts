import type { ViewNode } from "./types";

/**
 * The modules a level draws: its nodes less what is not a module of its own
 * (the drilled-into module's boundary ports, a board's net junctions and
 * their taps). A level with none is empty, whatever ports it shows.
 */
export function levelModules(nodes: readonly ViewNode[]): ViewNode[] {
  return nodes.filter((n) => !n.sheetPort && !n.net && !n.tapOf);
}
