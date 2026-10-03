/**
 * Renders the viewer into an element: shared by the standalone app (main.tsx)
 * and the library entry for hosts (lib.tsx).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles/tokens.css";
import "./styles/app.css";
import App, { type AppProps } from "./App";
import type { ViewerHandle } from "./api";
import { mergeOptions } from "./options";

export function render(element: HTMLElement, props: AppProps): ViewerHandle {
  const root = createRoot(element);
  let current = props;
  const draw = () =>
    root.render(
      <StrictMode>
        <App {...current} />
      </StrictMode>,
    );
  draw();
  return {
    update(options) {
      current = mergeOptions(current, options);
      draw();
    },
    unmount: () => root.unmount(),
  };
}
