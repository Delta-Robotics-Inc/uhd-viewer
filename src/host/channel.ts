/**
 * The viewer's side of the host channel: commands from the handle or the
 * parent window reach the mounted viewer (queued until it has a model on
 * screen), and its events go to the host's callbacks and, in a frame, to the
 * parent window.
 */
import type { ViewerEvent, ViewerHostMessage, ViewerOptions } from "../api";
import { TELEMETRY_EVENT, originAllowed, parseHostMessage, parseTelemetryMessage, type TelemetryMessage } from "./protocol";

/** The part of `window` the telemetry relay uses. */
export interface TelemetryEventWindow {
  addEventListener(type: string, listener: (e: Event) => void): void;
  removeEventListener(type: string, listener: (e: Event) => void): void;
}

/**
 * Relays the viewer's telemetry records (src/telemetry/: the window event
 * `uhd-viewer:telemetry`) to a host: `post` gets each one as a checked
 * `{ type: "uhd-viewer:telemetry", record }`. A host page calls this once
 * and forwards the message its own way (the VS Code webview to the
 * extension host, `protoboard dev`'s page to its server). Returns the stop.
 */
export function relayTelemetry(win: TelemetryEventWindow, post: (message: TelemetryMessage) => void): () => void {
  const listener = (e: Event) => {
    const m = parseTelemetryMessage((e as CustomEvent).detail);
    if (!m) return;
    try {
      post(m);
    } catch {
      // a host that cannot take it: the record is dropped, the viewer goes on
    }
  };
  win.addEventListener(TELEMETRY_EVENT, listener);
  return () => win.removeEventListener(TELEMETRY_EVENT, listener);
}

/** Host messages on their way to the viewer component (App.tsx subscribes once it shows a model). */
export interface CommandBus {
  send(message: ViewerHostMessage): void;
  /** Receive messages, first the ones that waited; returns the unsubscribe. */
  subscribe(handler: (message: ViewerHostMessage) => void): () => void;
}

export function commandBus(): CommandBus {
  let handler: ((message: ViewerHostMessage) => void) | undefined;
  let waiting: ViewerHostMessage[] = [];
  return {
    send(message) {
      if (handler) handler(message);
      else waiting.push(message);
    },
    subscribe(h) {
      handler = h;
      const queued = waiting;
      waiting = [];
      for (const m of queued) h(m);
      return () => {
        if (handler === h) handler = undefined;
      };
    },
  };
}

/** Calls the option callback that matches an event. */
export function deliver(options: ViewerOptions, event: ViewerEvent): void {
  switch (event.type) {
    case "uhd-viewer:ready":
      return options.onReady?.();
    case "uhd-viewer:selectionChanged":
      return options.onSelectionChanged?.(event.selection);
    case "uhd-viewer:openSource":
      return options.onOpenSource?.({ defId: event.defId, ...(event.instancePath !== undefined ? { instancePath: event.instancePath } : {}) });
    case "uhd-viewer:openArtifact":
      return options.onOpenArtifact?.({ defId: event.defId, artifactId: event.artifactId });
    case "uhd-viewer:openModule":
      return options.onOpenModule?.({ path: event.path, ...(event.view ? { view: event.view } : {}) });
    case "uhd-viewer:openPair":
      return options.onOpenPair?.({ linkId: event.linkId, a: event.a, b: event.b });
    case "uhd-viewer:inspect":
      return options.onInspect?.({ path: event.path, ...(event.defId ? { defId: event.defId } : {}) });
    case "uhd-viewer:viewState":
      return options.onViewStateChange?.(event.file);
    case "uhd-viewer:presentation":
      return options.onPresentationChange?.(event.presentation);
    case "uhd-viewer:bridgeReply":
      // a reply goes back the way its request came (the parent window); no option callback
      return;
    case "uhd-viewer:sequenceState":
      return options.onSequenceState?.(event);
    case "uhd-viewer:presence":
      return options.onPresenceChange?.(event.presence);
    // R2-A (F1, F3): a part's own model opened in place or in a new tab, and the viewer's back and forward
    case "uhd-viewer:navigate": {
      const { type: _type, ...request } = event;
      return options.onNavigate?.(request);
    }
    case "uhd-viewer:history": {
      const { type: _type, ...state } = event;
      return options.onHistory?.(state);
    }
    // R2-E (G3): the 3D toolbar's Export
    case "uhd-viewer:export":
      return options.onExport?.({ format: event.format, ...(event.target !== undefined ? { target: event.target } : {}) });
    // wave R4 gate: a viewer setting changed in the view (the scale chooser, units)
    case "uhd-viewer:setting":
      return options.onSetting?.({ key: event.key, value: event.value });
  }
}

/** The part of `window` the parent channel uses (a test passes its own). */
export interface ChannelWindow {
  /** The frame's parent (the window itself when not in a frame). */
  parent: { postMessage(message: unknown, targetOrigin: string): void };
  location: { origin: string; ancestorOrigins?: ArrayLike<string> };
  document?: { referrer?: string };
  addEventListener(type: "message", listener: (e: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (e: MessageEvent) => void): void;
}

export interface ParentChannel {
  /** Post an event to the parent (held until the parent's origin is known). */
  post(event: ViewerEvent): void;
  close(): void;
}

/** Events held while the parent's origin is unknown; past this only the latest are kept. */
const HELD = 64;

/**
 * Events that carry the view's state, an agent's reply or who is working where: never posted to `*` (a parent
 * whose origin is opaque, "null", or a host that allowed any origin), only to a known origin (wave 2 gate: the
 * channel posted view state to `*` when the parent's origin was null). Telemetry records stay with the host the
 * same way.
 */
export const PRIVATE_EVENTS = new Set(["uhd-viewer:viewState", "uhd-viewer:presentation", "uhd-viewer:bridgeReply", "uhd-viewer:presence", "uhd-viewer:sequenceState", "uhd-viewer:telemetry"]);

/**
 * The postMessage channel with the parent window. Accepts host messages from
 * `win.parent` only, from an allowed origin (default: `win`'s own). Events
 * go to the parent's origin: the frame's ancestor origin or referrer when it
 * is allowed, the only allowed origin when exactly one is listed, else the
 * origin of the parent's first accepted message (events wait until then).
 * Returns undefined when `win` is not in a frame. The viewer's telemetry
 * records (`relayTelemetry`) go to the parent the same way, as
 * `{ type: "uhd-viewer:telemetry", record }`.
 */
export function connectParent(win: ChannelWindow, options: { origins?: string[]; onMessage: (message: ViewerHostMessage) => void }): ParentChannel | undefined {
  const parent = win.parent;
  if (!parent || (parent as unknown) === win) return undefined;
  const allowed = options.origins?.length ? options.origins : [win.location.origin];
  const guess = win.location.ancestorOrigins?.[0] ?? referrerOrigin(win.document?.referrer);
  let target: string | undefined =
    guess && guess !== "null" && originAllowed(guess, allowed)
      ? guess
      : allowed.length === 1 && !allowed[0].includes("*")
        ? allowed[0]
        : allowed.length === 1 && allowed[0] === "*"
          ? "*"
          : undefined;
  let held: (ViewerEvent | TelemetryMessage)[] = [];
  let warned = false;
  const flush = () => {
    if (!target) return;
    const out = held;
    held = [];
    for (const e of out) {
      if (target === "*" && PRIVATE_EVENTS.has((e as { type: string }).type)) {
        if (!warned) console.warn("[uhd-viewer] the parent window's origin is not known (opaque or `*`): the view state, agent replies and presence are not posted to it");
        warned = true;
        continue;
      }
      parent.postMessage(e, target);
    }
  };
  const listener = (e: MessageEvent) => {
    if (e.source !== parent || !originAllowed(e.origin, allowed)) return;
    const message = parseHostMessage(e.data);
    if (!message) return;
    if (!target || target === "*") {
      target = e.origin === "null" ? "*" : e.origin;
      flush();
    }
    options.onMessage(message);
  };
  win.addEventListener("message", listener);
  const hold = (event: ViewerEvent | TelemetryMessage) => {
    held.push(event);
    if (held.length > HELD) held = held.slice(-HELD);
    flush();
  };
  // the window of a test (or an odd host) may not take other event types: then no telemetry, nothing else changes
  let stopTelemetry = () => {};
  try {
    stopTelemetry = relayTelemetry(win as unknown as TelemetryEventWindow, hold);
  } catch {
    stopTelemetry = () => {};
  }
  return {
    post: hold,
    close: () => {
      win.removeEventListener("message", listener);
      stopTelemetry();
    },
  };
}

function referrerOrigin(referrer?: string): string | undefined {
  if (!referrer) return undefined;
  try {
    return new URL(referrer).origin;
  } catch {
    return undefined;
  }
}
