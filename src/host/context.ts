/**
 * What the host takes over in the inspector and on the canvas: opening a
 * module's source (offered only when a host takes it) and artifact files
 * (opened by the host instead of in a new tab).
 */
import { createContext, useContext } from "react";
import type { ArtifactDef, ModuleDef } from "@uhd/types/index.js";
import type { ArtifactPreview } from "../model/artifacts";
import type { EvidenceFiles } from "../model/evidence";

export interface HostActions {
  openSource?: (defId: string, instancePath?: string) => void;
  openArtifact?: (defId: string, artifactId: string) => void;
  /** Open a module on its own (the host's new tab); given only when the host takes it. */
  openModule?: (path: string) => void;
  /** Open a web address (an evidence source); not given: a link in a new tab. */
  openLink?: (url: string) => void;

  // ---- how artifacts are shown (chrome/ArtifactCards.tsx); every one optional
  /**
   * `"live"` (default): a module's body model turns in a small 3D preview
   * above its cards. `"cards"`: no model is loaded for the inspector; the
   * model is a card like the others, with the picture `artifactPreview` gives.
   */
  artifactModels?: "live" | "cards";
  /** A picture for an artifact that is not an image itself (a model's exported preview, or the model to draw small). */
  artifactPreview?: (def: ModuleDef, artifact: ArtifactDef) => ArtifactPreview | undefined;
  /** Draws a model small, as a picture's URL, for a card whose preview is a model. Not given: such cards show their icon. */
  drawModel?: (src: string) => Promise<string>;
  /** Load pictures from web addresses (default true). */
  remoteImages?: boolean;
  /** A definition's evidence files (sources.json, verification.json), when the host has them. */
  evidence?: (defId: string) => EvidenceFiles | undefined;
}

export const HostContext = createContext<HostActions>({});
export const useHost = () => useContext(HostContext);
