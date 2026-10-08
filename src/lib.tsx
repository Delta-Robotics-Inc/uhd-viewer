/**
 * Library entry for hosts: mount the plain viewer app into an element.
 *
 *   import { mountViewer } from "@deltarobotics/uhd-viewer";
 *   import "@deltarobotics/uhd-viewer/style.css";
 *   const viewer = mountViewer(el, { bundleUrl: "/uhd-bundle.json", onLayoutChange: save });
 *
 * The element needs a height; the viewer fills it. Hosts that build their own
 * shell from the viewer's components use `@deltarobotics/uhd-viewer/components`.
 */
import "./styles/index.css";
import type { ViewerHandle, ViewerOptions } from "./api";
import App from "./app/App";
import { renderViewer } from "./viewer/mount";

export type {
  ArtifactResolver,
  LinkLayout,
  NodeMark,
  NodeMarkTone,
  ViewerEvent,
  ViewerHandle,
  ViewerHostMessage,
  ViewerLayout,
  ViewerOptions,
  ViewerSelection,
  ViewerTheme,
  ViewerThemeAdapter,
  ViewerThemeOption,
  ViewerView,
} from "./api";

export function mountViewer(element: HTMLElement, options: ViewerOptions): ViewerHandle {
  if (!options.bundle && !options.bundleUrl) throw new Error("mountViewer: give a bundle or a bundleUrl");
  return renderViewer(element, options, App);
}
