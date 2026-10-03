/**
 * The standalone app. The bundle comes from `?bundle=<url>`, else from the
 * config a server injected into the page (`uhd-viewer serve`), else, in
 * development only, from the default named in vite.config.ts.
 *
 * In a frame, the app talks to its parent window over postMessage (README,
 * "Host messages") when the parent is on the app's own origin, or on an
 * origin the page allows: `?hostOrigin=<origin>[,<origin>…]` (or `*`, or
 * `scheme://*`), or `hostOrigins` in the injected config.
 */
import { registerEvidenceFiles } from "./model/evidence";
import { pickBundleUrl } from "./source/source";
import { render } from "./mount";
import { originList } from "./host/protocol";

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
  // the part library's evidence files exist only next to a development checkout
  if (import.meta.env.DEV) registerEvidenceFiles((await import("./model/library-evidence")).libraryEvidence);
  const config = injectedConfig();
  render(document.getElementById("root")!, {
    bundleUrl: pickBundleUrl(window.location.search, config.bundleUrl, __DEFAULT_BUNDLE__),
    fsRoute: import.meta.env.DEV,
    parentWindow: parentWindow(config.hostOrigins),
  });
}

/** The parent channel: in a frame whose parent is allowed (its own origin, or one the page lists). */
function parentWindow(injected?: string[]): { origins: string[] } | undefined {
  if (window.parent === window) return undefined;
  const listed = [...originList(new URLSearchParams(window.location.search).get("hostOrigin")), ...(Array.isArray(injected) ? injected : [])];
  if (listed.length) return { origins: listed };
  try {
    // readable only when the parent is on this origin
    return window.parent.location.origin === window.location.origin ? { origins: [window.location.origin] } : undefined;
  } catch {
    return undefined;
  }
}

void start();
