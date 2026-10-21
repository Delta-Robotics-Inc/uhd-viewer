/**
 * A definition's artifacts as cards: every artifact is one card with a kind
 * (image, 3D model, schematic, PCB, datasheet, document, …), a title, where
 * it comes from (a file, or the host of its URL) and, where it has one, a
 * picture to show. No React here: the inspector draws the cards
 * (chrome/ArtifactCards.tsx), a host may read the same list.
 */
import type { ArtifactDef, ModuleDef } from "@uhd/types/index.js";
import type { ArtifactResolver } from "../api";

export type ArtifactKind = "image" | "model" | "schematic" | "pcb" | "drawing" | "datasheet" | "document" | "source" | "firmware" | "data" | "evidence";

/** The sections cards are shown in, in this order. */
export type ArtifactGroup = "images" | "models" | "board" | "datasheets" | "documents" | "evidence" | "design" | "data";

export const ARTIFACT_GROUPS: { id: ArtifactGroup; title: string }[] = [
  { id: "images", title: "IMAGES" },
  { id: "models", title: "3D MODELS" },
  { id: "board", title: "BOARD DRAWINGS" },
  { id: "datasheets", title: "DATASHEETS" },
  { id: "documents", title: "DOCUMENTS" },
  { id: "evidence", title: "EVIDENCE SOURCES" },
  { id: "design", title: "DESIGN FILES" },
  { id: "data", title: "DATA" },
];

/** What a card shows above its title: a picture, or a model a host may draw small. */
export type ArtifactPreview = { kind: "image"; src: string } | { kind: "model"; src: string };

export interface ArtifactCardModel {
  /** Unique among a definition's cards. */
  key: string;
  defId: string;
  /** The artifact's id (absent for a card that is not an artifact of the definition: an evidence source). */
  artifactId?: string;
  title: string;
  kind: ArtifactKind;
  group: ArtifactGroup;
  /** The kind in words: "Datasheet", "STEP model", "PCB top". */
  kindLabel: string;
  /** The file format, upper case: "PDF", "STEP", "GLB". */
  format?: string;
  /** Where it comes from, short: a URL's host, a file's name. */
  source?: string;
  /** More about the source: its authority and when it was fetched ("manufacturer · fetched 2026-10-03"). */
  sourceNote?: string;
  /** The whole URL or path, for the tooltip. */
  location?: string;
  /** What a click opens when no host takes artifacts. */
  href?: string;
  /** Lucide icon name, drawn when there is no picture. */
  icon: string;
  preview?: ArtifactPreview;
  /** The artifact is a web address, not a file of the project. */
  remote: boolean;
  description?: string;
  /** The same model in other formats (a STEP and the GLB exported with it): one card, each format a way to open it. */
  also?: { artifactId: string; format?: string; href?: string }[];
}

/** An evidence source row (sources.json), as far as cards need it. */
export interface ArtifactSourceRow {
  id: string;
  title: string;
  url: string;
  type?: string;
  authority?: string;
  fetched_at?: string;
}

export interface ArtifactCardOptions {
  /**
   * A picture for an artifact that is not an image itself (a model's exported
   * preview, or the model for the host to draw small). Not given: such cards
   * show their icon.
   */
  previewFor?: (def: ModuleDef, artifact: ArtifactDef) => ArtifactPreview | undefined;
  /** Load pictures from web addresses (default true). A host that loads only its own files turns it off: those cards show their icon. */
  remoteImages?: boolean;
  /** The definition's evidence sources: an artifact with the same URL says its authority and when it was fetched; `evidence: true` lists the others as cards of their own. */
  sources?: ArtifactSourceRow[];
  evidence?: boolean;
  /** Artifacts to leave out (already shown another way). */
  skip?: (artifact: ArtifactDef) => boolean;
  /**
   * Keep a part's internal geometry: the per-interface models its mates are computed from (role `interface`),
   * which a module's cards leave out (QA B2: 17 "interface geometry" GLBs on a flight controller). An
   * interface's own card asks for them.
   */
  internal?: boolean;
  /** One card per model, its formats together (`mergeFormats`; default true). */
  mergeFormats?: boolean;
}

/** An artifact that is a part's internal geometry, not something to open: one interface's mating model. */
export const isInternalArtifact = (a: Pick<ArtifactDef, "role">): boolean => a.role === "interface";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg", "avif"]);
const MODEL_EXT = new Set(["glb", "gltf", "step", "stp", "stl", "3mf", "obj", "iges", "igs"]);
const SOURCE_EXT = new Set(["py", "kcl", "ts", "tsx", "js", "scad", "kicad_pcb", "kicad_sch", "c", "h", "cpp"]);
const DATA_EXT = new Set(["json", "csv", "tsv", "yaml", "yml", "xml"]);
const DOC_EXT = new Set(["pdf", "html", "htm", "md", "txt"]);

/** The address without its query and fragment. */
const bare = (s: string) => s.split(/[?#]/)[0];
/** A file's or URL's last path segment. */
export const artifactFileName = (a: Pick<ArtifactDef, "filePath" | "url">): string => bare(a.filePath ?? a.url ?? "").split("/").filter(Boolean).pop() ?? "";

/** The extension of an artifact's file or URL, lower case (only a short alphanumeric one counts). */
export function artifactExtension(a: Pick<ArtifactDef, "filePath" | "url">): string {
  const m = /\.([a-z0-9_]{1,10})$/i.exec(artifactFileName(a));
  return m ? m[1].toLowerCase() : "";
}

/** A URL's host without `www.`, or undefined when it is not a URL. */
export function hostOf(url: string | undefined): string | undefined {
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

const sameUrl = (a: string, b: string) => bare(a).replace(/\/$/, "").toLowerCase() === bare(b).replace(/\/$/, "").toLowerCase();

const sourceNote = (s: ArtifactSourceRow | undefined): string | undefined => {
  if (!s) return undefined;
  return [s.authority, s.fetched_at ? `fetched ${s.fetched_at.slice(0, 10)}` : ""].filter(Boolean).join(" · ") || undefined;
};

interface Classified {
  kind: ArtifactKind;
  group: ArtifactGroup;
  kindLabel: string;
  icon: string;
}

/** What an artifact is, from its type, role, format and file name. */
export function classifyArtifact(a: ArtifactDef): Classified {
  const ext = artifactExtension(a);
  const format = (a.format ?? ext).toLowerCase();
  const name = artifactFileName(a).toLowerCase();
  const image = Boolean(a.mimeType?.startsWith("image/")) || IMAGE_EXT.has(ext);
  if (name === "schematic.svg" || (a.type === "schematic" && image)) return { kind: "schematic", group: "board", kindLabel: "Schematic", icon: "circuit-board" };
  if (name === "pcb-top.svg") return { kind: "pcb", group: "board", kindLabel: "PCB top", icon: "cpu" };
  if (name === "pcb-bottom.svg") return { kind: "pcb", group: "board", kindLabel: "PCB bottom", icon: "cpu" };
  if (a.type === "pcb" && image) return { kind: "pcb", group: "board", kindLabel: "PCB", icon: "cpu" };
  if (a.type === "datasheet") return { kind: "datasheet", group: "datasheets", kindLabel: "Datasheet", icon: "file-text" };
  // the small models a part carries for each mating face
  if (a.role === "interface") return { kind: MODEL_EXT.has(format) ? "model" : "source", group: "data", kindLabel: "Interface geometry", icon: "scan" };
  if (MODEL_EXT.has(format) || MODEL_EXT.has(ext)) {
    const f = MODEL_EXT.has(format) ? format : ext;
    if (f === "stl" || f === "3mf") return { kind: "model", group: "design", kindLabel: "Print model", icon: "printer" };
    if (a.role === "source") return { kind: "model", group: "design", kindLabel: `${f.toUpperCase()} source`, icon: "box" };
    return { kind: "model", group: "models", kindLabel: f === "step" || f === "stp" ? "STEP model" : f === "glb" || f === "gltf" ? "3D model" : `${f.toUpperCase()} model`, icon: f === "step" || f === "stp" ? "box" : "rotate-3d" };
  }
  if (a.role === "drawing" || format === "dxf" || ext === "dxf") return image ? { kind: "drawing", group: "images", kindLabel: "Drawing", icon: "ruler" } : { kind: "drawing", group: "design", kindLabel: "Drawing", icon: "ruler" };
  if (image) return { kind: "image", group: "images", kindLabel: a.tags?.includes("thumbnail") ? "Picture" : "Image", icon: "image" };
  if (a.type === "firmware") return { kind: "firmware", group: "design", kindLabel: "Firmware", icon: "binary" };
  if (a.type === "documentation" || DOC_EXT.has(ext)) return { kind: "document", group: "documents", kindLabel: ext === "pdf" ? "Document" : a.url && !a.filePath ? "Web page" : "Document", icon: ext === "pdf" ? "file-text" : a.url && !a.filePath ? "globe" : "file-text" };
  if (a.role === "source" && !DATA_EXT.has(ext)) return { kind: "source", group: "design", kindLabel: a.type === "pcb" || a.type === "schematic" ? "Board source" : a.type === "cad" ? "CAD source" : "Source", icon: "file-code" };
  if (SOURCE_EXT.has(ext)) return { kind: "source", group: "design", kindLabel: "Source", icon: "file-code" };
  if (DATA_EXT.has(ext) || DATA_EXT.has(format)) return { kind: "data", group: "data", kindLabel: /manifest/.test(name) ? "Manifest" : "Data", icon: "braces" };
  if (a.url && !a.filePath) return { kind: "document", group: "documents", kindLabel: "Link", icon: "link" };
  return { kind: "data", group: "data", kindLabel: "File", icon: "file" };
}

/** One artifact as a card. */
export function artifactCard(def: ModuleDef, a: ArtifactDef, resolve: ArtifactResolver, options: ArtifactCardOptions = {}): ArtifactCardModel {
  const c = classifyArtifact(a);
  const ext = artifactExtension(a);
  const remote = !a.filePath && Boolean(a.url);
  const resolved = a.filePath ? resolve(def.id, a.filePath) : undefined;
  const href = a.url ?? resolved;
  const isImage = Boolean(a.mimeType?.startsWith("image/")) || IMAGE_EXT.has(ext);
  const src = isImage ? (resolved ?? (options.remoteImages === false ? undefined : a.url)) : undefined;
  const preview: ArtifactPreview | undefined = src ? { kind: "image", src } : options.previewFor?.(def, a);
  const row = a.url ? options.sources?.find((s) => sameUrl(s.url, a.url!)) : undefined;
  const format = (a.format ?? ext).toUpperCase();
  const tool = a.provenance && typeof (a.provenance as { tool?: unknown }).tool === "string" ? ((a.provenance as { tool?: string }).tool as string) : undefined;
  return {
    key: `${def.id}#${a.id}`,
    defId: def.id,
    artifactId: a.id,
    title: a.name || artifactFileName(a) || a.id,
    ...c,
    ...(format && format.length <= 9 ? { format } : {}),
    ...(remote ? (hostOf(a.url) ? { source: hostOf(a.url) } : {}) : artifactFileName(a) ? { source: artifactFileName(a) } : {}),
    ...(remote ? (sourceNote(row) ? { sourceNote: sourceNote(row) } : {}) : tool ? { sourceNote: tool } : {}),
    ...(a.url ?? a.filePath ? { location: a.url ?? a.filePath } : {}),
    ...(href ? { href } : {}),
    ...(preview ? { preview } : {}),
    remote,
    ...(a.description ? { description: a.description } : {}),
  };
}

/** A definition's evidence sources (sources.json), each as a card: its title, what kind of source, its host, its authority and when it was fetched. */
export const evidenceSourceCards = (defId: string, sources: ArtifactSourceRow[]): ArtifactCardModel[] => sources.map((s) => sourceCard(defId, s));

function sourceCard(defId: string, s: ArtifactSourceRow): ArtifactCardModel {
  return {
    key: `${defId}#source:${s.id}`,
    defId,
    title: s.title,
    kind: "evidence",
    group: "evidence",
    kindLabel: s.type === "datasheet" ? "Datasheet" : s.type === "documentation" ? "Documentation" : s.type ? s.type.replace(/_/g, " ") : "Source",
    ...(hostOf(s.url) ? { source: hostOf(s.url) } : {}),
    ...(sourceNote(s) ? { sourceNote: sourceNote(s) } : {}),
    location: s.url,
    href: s.url,
    icon: s.type === "datasheet" ? "file-text" : s.authority === "manufacturer" ? "badge-check" : "globe",
    remote: true,
  };
}

const ORDER: Record<string, number> = { "PCB top": 0, "PCB bottom": 1, Schematic: 2, "STEP model": 0, "3D model": 1 };

/**
 * Every artifact of a definition as a card, in the order of the groups; with
 * `evidence`, the definition's evidence sources that no artifact names follow
 * as cards too.
 */
export function artifactCards(def: ModuleDef | undefined, resolve: ArtifactResolver, options: ArtifactCardOptions = {}): ArtifactCardModel[] {
  if (!def) return [];
  const arts = (def.artifacts ?? []).filter((a) => (a.filePath || a.url) && !options.skip?.(a) && (options.internal || !isInternalArtifact(a)));
  const cards = arts.map((a) => artifactCard(def, a, resolve, options));
  if (options.evidence) for (const s of options.sources ?? []) if (!arts.some((a) => a.url && sameUrl(a.url, s.url))) cards.push(sourceCard(def.id, s));
  const rank = new Map(ARTIFACT_GROUPS.map((g, i) => [g.id, i]));
  const sorted = cards
    .map((c, i) => ({ c, i }))
    .sort((x, y) => rank.get(x.c.group)! - rank.get(y.c.group)! || (ORDER[x.c.kindLabel] ?? 9) - (ORDER[y.c.kindLabel] ?? 9) || x.i - y.i)
    .map((x) => x.c);
  return options.mergeFormats === false ? sorted : mergeFormats(sorted);
}

/**
 * One card per model (QA B2): models that are one file in several formats (`body.step` and `body.glb`, beside
 * each other) are one card, the first's (a STEP before its GLB), with every format named and the others in
 * `also`. Its title loses a "(STEP)" that named the format.
 */
export function mergeFormats(cards: ArtifactCardModel[]): ArtifactCardModel[] {
  const stem = (c: ArtifactCardModel) => (c.group === "models" && !c.remote && c.location ? c.location.replace(/\.[^./]+$/, "") : undefined);
  const first = new Map<string, ArtifactCardModel>();
  const out: ArtifactCardModel[] = [];
  for (const c of cards) {
    const key = stem(c);
    const into = key ? first.get(key) : undefined;
    if (!into) {
      if (key) first.set(key, c);
      out.push(c);
      continue;
    }
    into.also = [...(into.also ?? []), { artifactId: c.artifactId!, ...(c.format ? { format: c.format } : {}), ...(c.href ? { href: c.href } : {}) }];
    into.format = [into.format, c.format].filter(Boolean).join(" · ");
    if (!into.preview && c.preview) into.preview = c.preview;
    into.title = into.title.replace(/\s*\((STEP|STP|GLB|GLTF|STL|3MF|OBJ|IGES|IGS)\)\s*$/i, "");
  }
  return out;
}

/** Cards by group, in the groups' order; empty groups are left out. */
export function groupArtifactCards(cards: ArtifactCardModel[]): { id: ArtifactGroup; title: string; cards: ArtifactCardModel[] }[] {
  return ARTIFACT_GROUPS.map((g) => ({ ...g, cards: cards.filter((c) => c.group === g.id) })).filter((g) => g.cards.length > 0);
}
