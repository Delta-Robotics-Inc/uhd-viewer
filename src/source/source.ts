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
      harnesses?: Record<string, LabelHint>;
      routes?: Record<string, LabelHint>;
    };
    /** By definition id. */
    appearance?: Record<string, Appearance>;
  };
}

export interface LoadedSource {
  name: string;
  bundleUrl: string;
  scenarios: ViewerScenario[];
  /** URL for a definition's artifact file path, or undefined if it cannot be resolved. */
  resolveArtifact: (definitionId: string, filePath: string) => string | undefined;
  /** Findings from the bundle's producer (e.g. ProtoBoard's aggregated check). */
  hostDiagnostics: UhdBundleDiagnostic[];
  display: DisplayConfig;
}

declare const __DEFAULT_BUNDLE__: string;

/** `?bundle=<url>` or the dev default (the ProtoBoard quadcopter project's build output). */
export function bundleUrlFromLocation(): string {
  return new URLSearchParams(window.location.search).get("bundle") ?? __DEFAULT_BUNDLE__;
}

/** Absolute filesystem bases are served through Vite's /@fs route in development. */
function baseToUrl(base: string): string {
  if (/^https?:\/\//.test(base) || base.startsWith("/@fs/")) return base.replace(/\/$/, "");
  if (base.startsWith("/")) return `/@fs${base}`.replace(/\/$/, "");
  return base.replace(/\/$/, "");
}

export async function loadBundle(url: string): Promise<LoadedSource> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load UHD bundle ${url} (${res.status})`);
  const bundle = (await res.json()) as UhdBundle;
  if (bundle.schema !== UHD_BUNDLE_SCHEMA) throw new Error(`${url} is not a UHD bundle (schema ${String(bundle.schema)})`);
  const here = url.replace(/[^/]*$/, "");
  const scenarios: ViewerScenario[] = [
    { id: "nominal", label: "Nominal", description: "", ...sys(bundle) },
    ...(bundle.scenarios ?? []).filter((s) => s.id !== "nominal").map((s) => ({ id: s.id, label: s.label, description: s.description ?? "", ...sys(bundle, s.id) })),
  ];
  const nominal = bundle.scenarios?.find((s) => s.id === "nominal");
  if (nominal) scenarios[0].label = nominal.label;
  return {
    name: bundle.meta?.name ?? bundle.root,
    bundleUrl: url,
    scenarios,
    resolveArtifact: (definitionId, filePath) => {
      if (/^https?:\/\//.test(filePath)) return filePath;
      const base = bundle.artifactBases?.[definitionId];
      return `${base ? baseToUrl(base) : here.replace(/\/$/, "")}/${filePath}`;
    },
    hostDiagnostics: bundle.diagnostics ?? [],
    display: (bundle.display ?? {}) as DisplayConfig,
  };
}

function sys(bundle: UhdBundle, scenario?: string): { system: ModuleDef; lookup: ModuleLookup } {
  const { root, lookup } = bundleSystem(bundle, scenario);
  return { system: root, lookup };
}
