/**
 * Viewer input (docs: protoboard-cli/docs/specs/uhd-boundary.md, "The viewer
 * contract"). The viewer shows whatever a UHD bundle describes: a root, its
 * definitions, scenarios, artifact bases, producer diagnostics and display
 * hints. It knows nothing about any particular project.
 */
import { bundleSystem } from "@uhd/system/bundle.js";
import { UHD_BUNDLE_SCHEMA, type UhdBundle, type UhdBundleDiagnostic } from "@uhd/types/bundle.js";
import type { ModuleDef } from "@uhd/types/index.js";
import type { ModuleLookup } from "@uhd/system/index.js";
import type { LevelLayout } from "../layout/layout";
import type { ArtifactResolver, ViewerOptions } from "../api";

export interface ViewerScenario {
  id: string;
  label: string;
  description: string;
  system: ModuleDef;
  lookup: ModuleLookup;
}

/** Surface appearance for a definition (and optionally named sub-bodies of its CAD). */
export interface Appearance {
  color?: string;
  metalness?: number;
  roughness?: number;
  opacity?: number;
  parts?: Record<string, Omit<Appearance, "parts">>;
}

export interface LabelHint {
  title?: string;
  sub?: string;
  hide?: boolean;
}

/** Presentation hints keyed by instance path. Never topology. */
export interface DisplayConfig {
  diagram?: {
    /** Hand layouts per drill level ("" = top). */
    layouts?: Record<string, LevelLayout>;
    /** Instance paths drawn expanded in place by default. */
    expanded?: string[];
    /** Links opened (conductors shown) by default. */
    openLinks?: string[];
  };
  spatial?: {
    /** Instance path the assembly is placed from (default: the best-connected structure). */
    root?: string;
    /** Explicit placements for modules no mate reaches (row-major 4×4, root coordinates). */
    placements?: Record<string, { matrix: number[]; note?: string }>;
    labels?: {
      modules?: Record<string, LabelHint>;
      /** Fastener harnesses and routed wire harnesses, by instance path. */
      harnesses?: Record<string, LabelHint>;
    };
    /** By definition id. */
    appearance?: Record<string, Appearance>;
    /** How the 3D view opens (PB-873). */
    view?: SpatialView;
  };
}

/**
 * The 3D view's opening camera, in the root's coordinates. Presentation only:
 * a watch modelled display-down (its case's frame has the display at −z)
 * says `up: [0, 0, -1]` and opens display-up, without changing the model.
 */
export interface SpatialView {
  /** The direction drawn up (default [0, 0, 1]): the camera's up, the orbit axis and the ground grid follow it. */
  up?: [number, number, number];
  /** A saved camera: azimuth and elevation (degrees, about `up`), distance (mm) and target. Without a distance the model is fitted. */
  camera?: { azimuth?: number; elevation?: number; distance?: number; target?: [number, number, number] };
}

export interface LoadedSource {
  name: string;
  bundleUrl: string;
  scenarios: ViewerScenario[];
  /** URL for a definition's artifact file path, or undefined if it cannot be resolved. */
  resolveArtifact: ArtifactResolver;
  /** Findings from the bundle's producer (e.g. ProtoBoard's aggregated check). */
  hostDiagnostics: UhdBundleDiagnostic[];
  display: DisplayConfig;
}

export interface SourceOptions {
  /** Development only: absolute filesystem bases are served through Vite's /@fs route. */
  fsRoute?: boolean;
  /** A host's resolver; it receives the default one as `fallback`. */
  resolveArtifact?: ViewerOptions["resolveArtifact"];
}

/**
 * The bundle URL for the standalone app: `?bundle=<url>`, then the URL a
 * server injected into the page, then the development default (none in a
 * production build).
 */
export function pickBundleUrl(search: string, injected?: string | null, fallback?: string | null): string | undefined {
  return new URLSearchParams(search).get("bundle") ?? injected ?? fallback ?? undefined;
}

/**
 * URL prefix for an artifact base (`UhdBundle.artifactBases`: an absolute
 * path or a URL prefix), or undefined when it cannot be fetched over HTTP.
 * Absolute filesystem paths only resolve in development, through /@fs.
 */
export function baseToUrl(base: string, options: Pick<SourceOptions, "fsRoute"> = {}): string | undefined {
  if (!base.startsWith("/")) return base.replace(/\/$/, "");
  // compiled out of production builds
  if (import.meta.env.DEV && options.fsRoute) return (base.startsWith("/@fs/") ? base : `/@fs${base}`).replace(/\/$/, "");
  return undefined;
}

/** The default resolver: a definition's artifact base, or the bundle's own location. */
export function bundleResolver(bundle: UhdBundle, bundleUrl: string, options: Pick<SourceOptions, "fsRoute"> = {}): ArtifactResolver {
  const here = bundleUrl.replace(/[^/]*$/, "").replace(/\/$/, "");
  const warned = new Set<string>();
  return (definitionId, filePath) => {
    if (/^https?:\/\//.test(filePath)) return filePath;
    const base = bundle.artifactBases?.[definitionId];
    const prefix = base ? baseToUrl(base, options) : here;
    if (prefix !== undefined) return `${prefix}/${filePath}`;
    if (base && !warned.has(base)) {
      warned.add(base);
      console.warn(`uhd-viewer: artifact base ${base} is a filesystem path; serve the bundle with \`uhd-viewer serve\` or give the viewer a resolver`);
    }
    return undefined;
  };
}

export async function loadBundle(url: string, options: SourceOptions = {}): Promise<LoadedSource> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load UHD bundle ${url} (${res.status})`);
  return sourceFromBundle((await res.json()) as UhdBundle, url, options);
}

export function sourceFromBundle(bundle: UhdBundle, url: string, options: SourceOptions = {}): LoadedSource {
  if (bundle.schema !== UHD_BUNDLE_SCHEMA) throw new Error(`${url} is not a UHD bundle (schema ${String(bundle.schema)})`);
  const scenarios: ViewerScenario[] = [
    { id: "nominal", label: "Nominal", description: "", ...sys(bundle) },
    ...(bundle.scenarios ?? []).filter((s) => s.id !== "nominal").map((s) => ({ id: s.id, label: s.label, description: s.description ?? "", ...sys(bundle, s.id) })),
  ];
  const nominal = bundle.scenarios?.find((s) => s.id === "nominal");
  if (nominal) scenarios[0].label = nominal.label;
  const fallback = bundleResolver(bundle, url, options);
  const host = options.resolveArtifact;
  return {
    name: bundle.meta?.name ?? bundle.root,
    bundleUrl: url,
    scenarios,
    resolveArtifact: host ? (definitionId, filePath) => host(definitionId, filePath, fallback) : fallback,
    hostDiagnostics: bundle.diagnostics ?? [],
    display: (bundle.display ?? {}) as DisplayConfig,
  };
}

function sys(bundle: UhdBundle, scenario?: string): { system: ModuleDef; lookup: ModuleLookup } {
  const { root, lookup } = bundleSystem(bundle, scenario);
  return { system: root, lookup };
}
