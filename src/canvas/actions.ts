/**
 * What a node's own controls do (the chevron of a module that holds
 * modules): the canvas provides them, the node components read them.
 */
import { createContext, useContext } from "react";

export interface CanvasActions {
  onToggleExpand?: (id: string) => void;
}

export const CanvasActionsContext = createContext<CanvasActions>({});
export const useCanvasActions = () => useContext(CanvasActionsContext);
