/**
 * Type declarations for the headless layout (dist/headless/index.d.ts,
 * PB-1007): the functions hosts call and the shapes they return, written
 * here (the view model and computed layout stay internal: only the parts a
 * host reads are declared). Checked with tsc as a consumer would see them.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "dist/headless");
writeFileSync(
  join(out, "index.d.ts"),
  `import type { UhdBundle } from "@deltarobotics/uhd";
import type { LinkLayout } from "../lib/api.js";

export interface Box { x: number; y: number; w: number; h: number }
/** One level of \`diagram.layouts\` in the display file. */
export interface LevelLayout {
  nodes: Record<string, { x?: number; y?: number; w?: number; h?: number }>;
  ports?: Record<string, "left" | "right" | "top" | "bottom">;
  links?: Record<string, LinkLayout>;
}
/** A level layout with the nodes the layout step must not move (the viewer ignores the list). */
export type PinnedLevelLayout = LevelLayout & { pinned?: string[] };
export interface LayoutMetrics {
  cards: number;
  links: number;
  crossings: number;
  overlaps: number;
  aspect: number;
  width: number;
  height: number;
  strip: number;
  stripAxis: "row" | "column";
  stripCards: string[];
  underCards: number;
  length: number;
  detail: { overlaps: [string, string][]; underCards: { link: string; card: string }[] };
}
export interface LayoutFinding {
  severity: "warning" | "info";
  code: "strip" | "crossings" | "overlaps" | "under-cards" | "aspect";
  message: string;
}
export interface LayoutLimits {
  strip: (cards: number) => number;
  crossings: (links: number) => number;
  aspect: [number, number];
}
export declare const LAYOUT_LIMITS: LayoutLimits;
export declare function layoutFindings(m: LayoutMetrics, limits?: LayoutLimits): LayoutFinding[];
export interface DiagramLevel { level: string; label: string; board: boolean }
export declare function diagramLevels(bundle: UhdBundle, maxDepth?: number): DiagramLevel[];
export interface LevelOptions {
  layout?: LevelLayout | null;
  expanded?: string[];
  legacy?: boolean;
}
export interface MeasuredLevel {
  level: string;
  saved: boolean;
  metrics: LayoutMetrics;
  findings: LayoutFinding[];
  /** What the viewer draws (internal shapes: read \`layout.boxes\` and \`layout.routes\` only). */
  view: { nodes: { id: string; label: string; parent?: string; kind: string }[] };
  layout: { boxes: Record<string, Box>; routes: Record<string, [number, number][]> };
}
export declare function measureLevel(bundle: UhdBundle, level: string, opts?: LevelOptions): MeasuredLevel;
export interface ProposeOptions extends LevelOptions {
  mode?: "default" | "tidy";
  pinned?: string[];
}
export interface Proposal {
  level: string;
  before: MeasuredLevel;
  after: MeasuredLevel;
  layout: PinnedLevelLayout;
  better: boolean;
}
export declare function proposeLevel(bundle: UhdBundle, level: string, opts?: ProposeOptions): Proposal;
export declare function reads(m: LayoutMetrics): number;
export declare function readsBetter(a: LayoutMetrics, b: LayoutMetrics): boolean;
`,
);

const tmp = mkdtempSync(join(tmpdir(), "uhd-viewer-headless-types-"));
try {
  writeFileSync(
    join(tmp, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        lib: ["ES2022", "DOM"],
        module: "ESNext",
        moduleResolution: "Bundler",
        skipLibCheck: false,
        types: [],
        paths: { "@deltarobotics/uhd": [join(root, "../uhd/src/types/index.ts")] },
      },
      files: [join(out, "index.d.ts")],
    }),
  );
  const tsc = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(tmp, "tsconfig.json")], { encoding: "utf8" });
  if (tsc.status !== 0) throw new Error(`headless declarations do not type-check:\n${tsc.stdout}${tsc.stderr}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log("dist/headless/index.d.ts written and checked");
