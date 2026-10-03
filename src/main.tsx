/**
 * The standalone app. The bundle comes from `?bundle=<url>`, else from the
 * config a server injected into the page (`uhd-viewer serve`), else, in
 * development only, from the default named in vite.config.ts.
 */
import { registerEvidenceFiles } from "./model/evidence";
import { pickBundleUrl } from "./source/source";
import { render } from "./mount";

declare const __DEFAULT_BUNDLE__: string | null;

/** `<script type="application/json" id="uhd-viewer-config">{"bundleUrl": "..."}</script>` */
function injectedConfig(): { bundleUrl?: string } {
  try {
    return JSON.parse(document.getElementById("uhd-viewer-config")?.textContent ?? "{}");
  } catch {
    return {};
  }
}

async function start() {
  // the part library's evidence files exist only next to a development checkout
  if (import.meta.env.DEV) registerEvidenceFiles((await import("./model/library-evidence")).libraryEvidence);
  render(document.getElementById("root")!, {
    bundleUrl: pickBundleUrl(window.location.search, injectedConfig().bundleUrl, __DEFAULT_BUNDLE__),
    fsRoute: import.meta.env.DEV,
  });
}

void start();
