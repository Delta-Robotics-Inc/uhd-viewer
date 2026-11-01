/**
 * Renders a viewer shell into an element: the standalone app (app/main.tsx,
 * lib.tsx's mountViewer) or a host's own shell built from the library's views
 * (`renderViewer(el, options, Shell)`). The handle carries the host channel:
 * its methods send host messages, events go to the options' callbacks and,
 * with `parentWindow`, to the parent window. The shell receives the options
 * and the channel (`host`) as props and passes them to `UhdViewer`.
 *
 * The 3D view's state (PB-1178, ../cad/state) lives in the page's view hub:
 * the handle reads and writes it, host messages and bridge requests reach it
 * here (not through the viewer component, so they land while the diagram is
 * shown), and its live part goes to the host 400 ms after it last changed.
 */
import { StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import type { AppProps, HostLink } from "./controller";
import type { ViewerEvent, ViewerHandle, ViewerOptions } from "../api";
import { mergeOptions } from "../options";
import { commandBus, connectParent, deliver, type ChannelWindow, type ParentChannel } from "../host/channel";
import { parseHostMessage } from "../host/protocol";
import type { ViewerHostMessage, ViewerSequenceCommand, ViewerSequenceReply } from "../api";
import { BRIDGE_REQUEST, handleBridgeMessage, presentation, same, viewHub, watchLiveState, type ViewState } from "../cad/state";

export function renderViewer<P extends AppProps>(element: HTMLElement, props: P, Shell: ComponentType<P>): ViewerHandle {
  const root = createRoot(element);
  const bus = commandBus();
  let current = props;
  let parent: ParentChannel | undefined;
  const hub = viewHub();
  const store = hub.store;
  const savePoints = () => {
    hub.savePoint = current.onSavePoint ? (p) => current.onSavePoint?.(p) : undefined;
  };
  savePoints();
  if (props.viewState) store.restore(props.viewState.scopes, "host");
  const hostActor: { kind: "host"; id: string } = { kind: "host", id: "host" };
  const setState = (state: Partial<ViewState>) => {
    const keys = ["camera", "selection", "highlight", "isolation", "visibility", "direction", "sections", "explode", "namedViews", "annotations"].filter((k) => k in state);
    const r = store.dispatch(
      keys.map((k) => ({ op: "set", path: [k], value: (state as Record<string, unknown>)[k] })),
      { actor: hostActor, label: "set by the host", source: "host" },
    );
    if (r && "error" in r) throw new Error(r.error);
  };
  const sequence = (command: ViewerSequenceCommand): ViewerSequenceReply =>
    hub.sequence ? hub.sequence(command) : { type: "uhd-viewer:sequenceState", ok: false, error: "the 3D view is not shown: show it (setView 3d), then send the command" };
  const bridge = (request: Parameters<ViewerHandle["bridge"]>[0]) => handleBridgeMessage(store, request, { observe: hub.observer ? () => hub.observer!({ components: false }) : undefined, view: () => hub.view });
  /** Host messages that are about the view state go to the store; the rest to the viewer component. */
  const route = (message: ViewerHostMessage) => {
    switch (message.type) {
      case "uhd-viewer:setViewState":
        try {
          setState(message.state);
        } catch (e) {
          console.warn(`[uhd-viewer] setViewState refused: ${(e as Error).message}`);
        }
        return;
      case "uhd-viewer:restoreViewState":
        store.restore(message.file.scopes, "host");
        return;
      case BRIDGE_REQUEST:
        // a frame's parent relays an agent's batch: the reply goes back to it
        parent?.post(bridge(message));
        return;
      case "uhd-viewer:sequence":
        emit(sequence(message.command));
        return;
      case "uhd-viewer:quality":
        hub.quality?.(message.config);
        return;
      case "uhd-viewer:snapshot":
        // kept for the 3D view of that level (it paints it, then goes live under it)
        hub.snapshot = message;
        hub.onSnapshot?.(message);
        return;
      default:
        bus.send(message);
    }
  };
  const connect = (option: ViewerOptions["parentWindow"]) => {
    parent?.close();
    parent = option ? connectParent(window as unknown as ChannelWindow, { origins: option === true ? undefined : option.origins, onMessage: route }) : undefined;
  };
  connect(props.parentWindow);
  const emit = (event: ViewerEvent) => {
    deliver(current, event);
    parent?.post(event);
  };
  // the live view state, 400 ms after it last changed (and when the page hides): the host saves it per user
  const live = watchLiveState(store, (file) => emit({ type: "uhd-viewer:viewState", file }));
  const flush = () => live.flush();
  const onVisibility = () => document.visibilityState === "hidden" && flush();
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", onVisibility);
  // named views and annotations: only an explicit save changes them, and the host writes them to the display file
  const stopPresentation = store.subscribe((c) => {
    if (c.source === "display" || (c.state.namedViews === c.prev.namedViews && c.state.annotations === c.prev.annotations)) return;
    if (same(presentation(c.state), presentation(c.prev))) return;
    emit({ type: "uhd-viewer:presentation", presentation: presentation(c.state) });
  });
  // one object while what the host takes stays the same (the viewer subscribes to it)
  let host: HostLink | undefined;
  const hostLink = (): HostLink => {
    const source = Boolean(current.onOpenSource || parent);
    const artifact = Boolean(current.onOpenArtifact || parent);
    // only a host that says it opens modules changes what double-click does
    const module = Boolean(current.onOpenModule);
    // a pair view of the host's own only when the host takes it (a frame's parent keeps the viewer's)
    const pair = Boolean(current.onOpenPair);
    const inspect = Boolean(current.onInspect);
    if (!host || host.source !== source || host.artifact !== artifact || host.module !== module || Boolean(host.pair) !== pair || Boolean(host.inspect) !== inspect) host = { bus, emit, source, artifact, module, pair, inspect };
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
    if (m) route(m);
    return Boolean(m);
  };
  return {
    update(options) {
      const before = current.parentWindow;
      current = mergeOptions(current, options as Partial<P>);
      if ("parentWindow" in options && JSON.stringify(before) !== JSON.stringify(current.parentWindow)) connect(current.parentWindow);
      if (options.viewState) store.restore(options.viewState.scopes, "host");
      savePoints();
      draw();
    },
    unmount: () => {
      live.flush();
      live.stop();
      stopPresentation();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      parent?.close();
      root.unmount();
    },
    focus: (path) => void post({ type: "uhd-viewer:focus", path }),
    select: (ids, options) => void post({ type: "uhd-viewer:select", ids, ...(options?.reveal === false ? { reveal: false } : {}) }),
    drill: (path) => void post({ type: "uhd-viewer:drill", path }),
    setView: (view) => void post({ type: "uhd-viewer:setView", view }),
    post,
    viewState: () => store.get(),
    setViewState: setState,
    restoreViewState: (file) => store.restore(file.scopes, "host"),
    bridge: (request) => (request && request.type === BRIDGE_REQUEST ? bridge(request) : undefined),
    presentation: () => presentation(store.get()),
    sequence,
  };
}
