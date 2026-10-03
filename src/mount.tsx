/**
 * Renders the viewer into an element: shared by the standalone app (main.tsx)
 * and the library entry for hosts (lib.tsx). The handle carries the host
 * channel: its methods send host messages, events go to the options'
 * callbacks and, with `parentWindow`, to the parent window.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles/tokens.css";
import "./styles/app.css";
import App, { type AppProps, type HostLink } from "./App";
import type { ViewerEvent, ViewerHandle, ViewerOptions } from "./api";
import { mergeOptions } from "./options";
import { commandBus, connectParent, deliver, type ChannelWindow, type ParentChannel } from "./host/channel";
import { parseHostMessage } from "./host/protocol";

export function render(element: HTMLElement, props: AppProps): ViewerHandle {
  const root = createRoot(element);
  const bus = commandBus();
  let current = props;
  let parent: ParentChannel | undefined;
  const connect = (option: ViewerOptions["parentWindow"]) => {
    parent?.close();
    parent = option ? connectParent(window as unknown as ChannelWindow, { origins: option === true ? undefined : option.origins, onMessage: bus.send }) : undefined;
  };
  connect(props.parentWindow);
  const emit = (event: ViewerEvent) => {
    deliver(current, event);
    parent?.post(event);
  };
  // one object while what the host takes stays the same (the viewer subscribes to it)
  let host: HostLink | undefined;
  const hostLink = (): HostLink => {
    const source = Boolean(current.onOpenSource || parent);
    const artifact = Boolean(current.onOpenArtifact || parent);
    if (!host || host.source !== source || host.artifact !== artifact) host = { bus, emit, source, artifact };
    return host;
  };
  const draw = () =>
    root.render(
      <StrictMode>
        <App {...current} host={hostLink()} />
      </StrictMode>,
    );
  draw();
  const post = (message: unknown) => {
    const m = parseHostMessage(message);
    if (m) bus.send(m);
    return Boolean(m);
  };
  return {
    update(options) {
      const before = current.parentWindow;
      current = mergeOptions(current, options);
      if ("parentWindow" in options && JSON.stringify(before) !== JSON.stringify(current.parentWindow)) connect(current.parentWindow);
      draw();
    },
    unmount: () => {
      parent?.close();
      root.unmount();
    },
    focus: (path) => void post({ type: "uhd-viewer:focus", path }),
    select: (ids, options) => void post({ type: "uhd-viewer:select", ids, ...(options?.reveal === false ? { reveal: false } : {}) }),
    drill: (path) => void post({ type: "uhd-viewer:drill", path }),
    setView: (view) => void post({ type: "uhd-viewer:setView", view }),
    post,
  };
}
