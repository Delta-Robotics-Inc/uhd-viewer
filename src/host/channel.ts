/**
 * The viewer's side of the host channel: commands from the handle or the
 * parent window reach the mounted viewer (queued until it has a model on
 * screen), and its events go to the host's callbacks and, in a frame, to the
 * parent window.
 */
import type { ViewerEvent, ViewerHostMessage, ViewerOptions } from "../api";
import { originAllowed, parseHostMessage } from "./protocol";

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
    case "uhd-viewer:openPair":
      return options.onOpenPair?.({ linkId: event.linkId, a: event.a, b: event.b });
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
 * The postMessage channel with the parent window. Accepts host messages from
 * `win.parent` only, from an allowed origin (default: `win`'s own). Events
 * go to the parent's origin: the frame's ancestor origin or referrer when it
 * is allowed, the only allowed origin when exactly one is listed, else the
 * origin of the parent's first accepted message (events wait until then).
 * Returns undefined when `win` is not in a frame.
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
  let held: ViewerEvent[] = [];
  const flush = () => {
    if (!target) return;
    const out = held;
    held = [];
    for (const e of out) parent.postMessage(e, target);
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
  return {
    post(event) {
      held.push(event);
      if (held.length > HELD) held = held.slice(-HELD);
      flush();
    },
    close: () => win.removeEventListener("message", listener),
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
