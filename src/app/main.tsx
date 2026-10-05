/**
 * The standalone app. `?theme=` picks its look (dark, light, system, vscode).
 * The bundle comes from `?bundle=<url>`, else from the
 * config a server injected into the page (`uhd-viewer serve`), else, in
 * development only, from the default named in vite.config.ts.
 *
 * In a frame, the app talks to its parent window over postMessage (README,
 * "Host messages") when the parent is on the app's own origin, or on an
 * origin the server allows: `hostOrigins` in the injected config
 * (`uhd-viewer serve --host-origin`). Not from the query: the framing page
 * writes the frame's URL, so it could allow itself. The Vite dev server alone
 * also takes `?hostOrigin=<origin>[,<origin>…]`, for trying a host locally.
 */
import "../styles/index.css";
import { pickBundleUrl } from "../source/source";
import { renderViewer } from "../viewer/mount";
import { originList } from "../host/protocol";
import type { ViewerThemeOption } from "../api";
import App from "./App";

declare const __DEFAULT_BUNDLE__: string | null;

/** `<script type="application/json" id="uhd-viewer-config">{"bundleUrl": "..."}</script>` */
function injectedConfig(): { bundleUrl?: string; hostOrigins?: string[] } {
  try {
    return JSON.parse(document.getElementById("uhd-viewer-config")?.textContent ?? "{}");
  } catch {
    return {};
  }
}

async function start() {
  const config = injectedConfig();
  renderViewer(
    document.getElementById("root")!,
    {
      bundleUrl: pickBundleUrl(window.location.search, config.bundleUrl, __DEFAULT_BUNDLE__),
      fsRoute: import.meta.env.DEV,
      parentWindow: parentWindow(config.hostOrigins),
      theme: themeOption(new URLSearchParams(window.location.search).get("theme")),
    },
    App,
  );
}

/** `?theme=dark|light|system|vscode` (default: the viewer's dark theme). */
function themeOption(value: string | null): ViewerThemeOption | undefined {
  return value === "dark" || value === "light" || value === "system" || value === "vscode" ? value : undefined;
}

/** The parent channel: in a frame whose parent is allowed (its own origin, or one the server lists). */
function parentWindow(injected?: string[]): { origins: string[] } | undefined {
  if (window.parent === window) return undefined;
  const fromQuery = import.meta.env.DEV ? originList(new URLSearchParams(window.location.search).get("hostOrigin")) : [];
  const listed = [...fromQuery, ...(Array.isArray(injected) ? injected.filter((o) => typeof o === "string") : [])];
  if (listed.length) return { origins: listed };
  try {
    // readable only when the parent is on this origin
    return window.parent.location.origin === window.location.origin ? { origins: [window.location.origin] } : undefined;
  } catch {
    return undefined;
  }
}

void start();
