/**
 * Renders a viewer shell into an element: the standalone app (app/main.tsx,
 * lib.tsx's mountViewer) or a host's own shell built from the library's views
 * (`renderViewer(el, options, Shell)`). The handle carries the host channel:
 * its methods send host messages, events go to the options' callbacks and,
 * with `parentWindow`, to the parent window. The shell receives the options
 * and the channel (`host`) as props and passes them to `UhdViewer`.
 */
import { StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import type { AppProps, HostLink } from "./controller";
import type { ViewerEvent, ViewerHandle, ViewerOptions } from "../api";
import { mergeOptions } from "../options";
import { commandBus, connectParent, deliver, type ChannelWindow, type ParentChannel } from "../host/channel";
import { parseHostMessage } from "../host/protocol";

export function renderViewer<P extends AppProps>(element: HTMLElement, props: P, Shell: ComponentType<P>): ViewerHandle {
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
    // only a host that says it opens modules changes what double-click does
    const module = Boolean(current.onOpenModule);
    // a pair view of the host's own only when the host takes it (a frame's parent keeps the viewer's)
    const pair = Boolean(current.onOpenPair);
    if (!host || host.source !== source || host.artifact !== artifact || host.module !== module || Boolean(host.pair) !== pair) host = { bus, emit, source, artifact, module, pair };
    return host;
  };
  const draw = () =>
    root.render(
      <StrictMode>
        <Shell {...current} host={hostLink()} />
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
      current = mergeOptions(current, options as Partial<P>);
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
