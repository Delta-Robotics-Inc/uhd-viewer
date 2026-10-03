/**
 * Library entry for hosts: mount the viewer into an element.
 *
 *   import { mountViewer } from "@deltarobotics/uhd-viewer";
 *   import "@deltarobotics/uhd-viewer/style.css";
 *   const viewer = mountViewer(el, { bundleUrl: "/uhd-bundle.json", onLayoutChange: save });
 *
 * The element needs a height; the viewer fills it.
 */
import type { ViewerHandle, ViewerOptions } from "./api";
import { render } from "./mount";

export type { ArtifactResolver, LinkLayout, ViewerHandle, ViewerLayout, ViewerOptions } from "./api";

export function mountViewer(element: HTMLElement, options: ViewerOptions): ViewerHandle {
  if (!options.bundle && !options.bundleUrl) throw new Error("mountViewer: give a bundle or a bundleUrl");
  return render(element, options);
}
