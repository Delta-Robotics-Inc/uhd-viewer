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
import type { ViewerHostMessage, ViewerSequenceCommand, ViewerSequenceReply, ViewerTheme, ViewerThemeAdapter, ViewerThemeOption } from "../api";
import { BRIDGE_REQUEST, WRITABLE_KEYS, handleBridgeMessage, presentation, same, splitBridgeReply, viewHub, watchLiveState, type ViewState, type ViewStore } from "../cad/state";
import { connectNav, navHostMessage } from "../cad/nav";
import { applyViewerSettings } from "../cad/viewerSettings";
import { resolveTheme, themeFromUrl } from "../theme/resolve";

/**
 * The host's theme option made to follow the view state's `theme` (W4-D, wave 3 carry-forward: a view-state write
 * after load switches the theme): `light`, `dark` or `system` written by the person, a host or `__cad.set` wins
 * over the host's option; absent, the option (and the page URL's `?theme=`) decide as before. The adapter
 * notifies on a theme write and passes on the chosen theme's own changes (system, VS Code).
 */
export function followViewStateTheme(option: ViewerThemeOption | undefined, store: Pick<ViewStore, "get" | "subscribe">): ViewerThemeAdapter {
  const choice = () => {
    const t = store.get().theme;
    return t === "light" || t === "dark" || t === "system" ? t : undefined;
  };
  // the view state's choice beats the URL; with none, the URL and the option as before
  const adapter = () => {
    const c = choice();
    // null, not undefined: undefined would take resolveTheme's default, the URL, over the view state's choice
    return c ? resolveTheme(c, null) : resolveTheme(option, themeFromUrl());
  };
  return {
    id: "view-state",
    current: () => adapter().current() as unknown as ViewerTheme,
    subscribe(onChange) {
      let inner = adapter();
      let stopInner = inner.subscribe?.((t) => onChange(t as unknown as ViewerTheme));
      const stopStore = store.subscribe((c) => {
        if (c.state.theme === c.prev.theme) return;
        stopInner?.();
        inner = adapter();
        stopInner = inner.subscribe?.((t) => onChange(t as unknown as ViewerTheme));
        onChange(inner.current() as unknown as ViewerTheme);
      });
      return () => {
        stopStore();
        stopInner?.();
      };
    },
  };
}

export function renderViewer<P extends AppProps>(element: HTMLElement, props: P, Shell: ComponentType<P>): ViewerHandle {
  const root = createRoot(element);
  const bus = commandBus();
  let current = props;
  let parent: ParentChannel | undefined;
  const hub = viewHub();
  const store = hub.store;
  // the theme follows a view-state write after load (W4-D); made once per host option so the shell keeps one adapter
  let themeFor: { option: ViewerThemeOption | undefined; adapter: ViewerThemeAdapter } | undefined;
  const themed = (p: P): P => {
    const option = (p as { theme?: ViewerThemeOption }).theme;
    if (!themeFor || themeFor.option !== option) themeFor = { option, adapter: followViewStateTheme(option, store) };
    return { ...p, theme: themeFor.adapter } as P;
  };
  const savePoints = () => {
    hub.savePoint = current.onSavePoint ? (p) => current.onSavePoint?.(p) : undefined;
  };
  savePoints();
  // R2-E's viewer settings (J1; R2 integration): on the hub for the 3D view (long hover, model info), zoom to the
  // pointer through the hub's camera controls; again on every `update({ settings })`
  applyViewerSettings(hub, props.settings);
  if (props.viewState) store.restore(props.viewState.scopes, "host");
  const hostActor: { kind: "host"; id: string } = { kind: "host", id: "host" };
  const setState = (state: Partial<ViewState>) => {
    // every writable key (R2-A's `highlightColor` included: a hard-coded list dropped it)
    const keys = WRITABLE_KEYS.filter((k) => k in state);
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
    // R2-A (F1): `uhd-viewer:historyGo` and `uhd-viewer:hostCapabilities` are navigation's
    if (navHostMessage(hub, message)) return;
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
      case "uhd-viewer:takeOver":
        // the person takes the view back: every agent lease ends, the camera is theirs (PB-1196)
        store.takeOver();
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
  // R2-A (F1): the viewer's own history and navigate requests reach the host; Back across levels is a drill here.
  // A library host takes navigate by giving `onNavigate`; a frame's parent says so with `uhd-viewer:hostCapabilities`.
  const stopNav = connectNav(hub, { emit, apply: (m) => route(m), navigates: () => Boolean(current.onNavigate), historyButtons: () => Boolean(current.onHistory) });
  // R2-E (G3): the toolbar's Export goes to a host that takes it (`onExport`, or a frame's parent); else it is disabled
  const exports = () => {
    hub.exportView = current.onExport || parent ? (request) => emit({ type: "uhd-viewer:export", ...request }) : undefined;
    // wave R4 gate (R4-B's handoff): the toolbar's scale chooser and units go to a host that saves settings
    hub.saveSetting = current.onSetting || parent ? (key, value) => (typeof value === "string" ? emit({ type: "uhd-viewer:setting", key, value }) : undefined) : undefined;
  };
  exports();
  // the live view state, 400 ms after it last changed (and when the page hides): the host saves it per user
  const live = watchLiveState(store, (file) => emit({ type: "uhd-viewer:viewState", file }));
  const flush = () => live.flush();
  const onVisibility = () => document.visibilityState === "hidden" && flush();
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", onVisibility);
  // named views (and annotations a person saves): only an explicit save changes the display file. A change of
  // annotations alone is not posted (gate 3, W3-A's bullet): agent callouts are live and per user, and the host
  // writes `spatial.annotations` only on a save that says `saveAnnotations: true` (DEFAULT, collaboration D10).
  // the person's explicit "Save callouts" (W4-D, D10): the presentation with `saveAnnotations: true`
  hub.saveCallouts = () => emit({ type: "uhd-viewer:presentation", presentation: { ...presentation(store.get()), saveAnnotations: true } });
  const stopPresentation = store.subscribe((c) => {
    if (c.source === "display" || c.state.namedViews === c.prev.namedViews) return;
    if (same(presentation(c.state), presentation(c.prev))) return;
    emit({ type: "uhd-viewer:presentation", presentation: presentation(c.state) });
  });
  // presence (PB-1196): who holds the camera, the leases, what each agent is working on; to the host when the
  // store says presence changed or an agent wrote, at most every 250 ms (DEFAULT), the last one always sent
  const PRESENCE_THROTTLE_MS = 250;
  let presenceTimer: ReturnType<typeof setTimeout> | undefined;
  let presenceAt = 0;
  const sendPresence = () => {
    presenceTimer = undefined;
    presenceAt = Date.now();
    emit({ type: "uhd-viewer:presence", presence: store.presence() });
  };
  const stopPresence = store.subscribe((c) => {
    if (c.source !== "presence" && c.entry?.actor.kind !== "agent") return;
    if (presenceTimer) return;
    const wait = Math.max(0, PRESENCE_THROTTLE_MS - (Date.now() - presenceAt));
    presenceTimer = setTimeout(sendPresence, wait);
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
        <Shell {...themed(current)} host={hostLink()} />
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
      if ("settings" in options) applyViewerSettings(hub, current.settings);
      savePoints();
      exports();
      draw();
    },
    unmount: () => {
      live.flush();
      live.stop();
      stopNav();
      stopPresentation();
      stopPresence();
      if (presenceTimer) clearTimeout(presenceTimer);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      parent?.close();
      root.unmount();
      // the hub outlives this mount (one per page): drop what this mount put on it (wave 2 gate item, W3-C's bullet)
      hub.savePoint = undefined;
      hub.saveCallouts = undefined;
      hub.snapshot = undefined;
      hub.onSnapshot = undefined;
      hub.exportView = undefined;
      hub.saveSetting = undefined;
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
    bridgeParts: (request, maxChars) => (request && request.type === BRIDGE_REQUEST ? splitBridgeReply(bridge(request), maxChars) : undefined),
    presentation: () => presentation(store.get()),
    sequence,
  };
}
