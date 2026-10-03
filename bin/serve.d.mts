/**
 * Declarations for `@deltarobotics/uhd-viewer/serve` (bin/serve.mjs), written
 * by hand: the server is plain JavaScript. test/serve-types.test.ts checks
 * that they match what the module exports.
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";

export declare const BUNDLE_SCHEMA: "uhd.bundle/v0";
/** URL path of the served (rewritten) bundle, relative to the app. */
export declare const BUNDLE_URL: "uhd-bundle.json";
export declare const DEFAULT_PORT: number;
/** The built app (dist/app) next to this file. */
export declare const APP_DIR: string;

export interface BundlePlan {
  /** URL name → base folder. */
  mounts: Map<string, string>;
  /** "<name>/<artifact path>" → file on disk. */
  files: Map<string, string>;
  /** Definition id → mount name or URL. */
  bases: Record<string, string>;
  /** The bundle as served from `origin` (artifact bases rewritten to URLs, everything else as given). */
  rewrite: (origin: string) => { [key: string]: unknown; artifactBases: Record<string, string> };
}

/** What to serve for one parsed `uhd.bundle/v0` read from `bundleFile`. Throws if it is not a bundle. */
export declare function planBundle(bundle: unknown, bundleFile: string): BundlePlan;

/** The app's index.html with `config` injected as `<script type="application/json" id="uhd-viewer-config">`. */
export declare function injectConfig(html: string, config: { bundleUrl?: string }): string;

export interface ViewerHandlerOptions {
  /** The bundle on disk (re-read when it changes). */
  bundleFile: string;
  /** The built app; defaults to APP_DIR. */
  appDir?: string;
  /** Which Host header names to answer; defaults to loopback names only. */
  allowHost?: (hostname: string) => boolean;
}

/** A request handler for the viewer, a bundle and its artifacts. It answers every request it is given. */
export declare function viewerHandler(options: ViewerHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export interface StartServerOptions {
  bundleFile: string;
  port?: number;
  /** Interface to bind; defaults to 127.0.0.1. */
  host?: string;
  appDir?: string;
}

/** Starts the server. Fails before listening if the bundle or the built app is missing. */
export declare function startServer(options: StartServerOptions): Promise<{ url: string; server: Server; close: () => Promise<void> }>;
