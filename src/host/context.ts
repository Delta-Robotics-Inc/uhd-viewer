/**
 * What the host takes over in the inspector and on the canvas: opening a
 * module's source (offered only when a host takes it) and artifact files
 * (opened by the host instead of in a new tab).
 */
import { createContext, useContext } from "react";

export interface HostActions {
  openSource?: (defId: string, instancePath?: string) => void;
  openArtifact?: (defId: string, artifactId: string) => void;
}

export const HostContext = createContext<HostActions>({});
export const useHost = () => useContext(HostContext);
