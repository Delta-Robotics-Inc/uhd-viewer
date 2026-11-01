/**
 * Saving the live view state on a debounce (PB-1178): the host is told 400 ms
 * after the last change (and at once when the page hides), and only when the
 * live keys changed since what it was last told. The host writes it
 * (`.protoboard/local/viewer-state.json` for `protoboard dev` and the VS Code
 * extension, the webview's own state in VS Code); the viewer never writes a
 * file.
 */
import type { ViewStore } from "./store";
import { viewerStateFile, type ViewerStateFile } from "./serialize";

/** The quiet period before the live state is handed to the host (Kevin's brief: 400 ms). */
export const LIVE_SAVE_MS = 400;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** `fn` once `ms` after the last `call`; `flush` runs a pending call now. */
export function debounce(fn: () => void, ms: number, timers: Timers = defaultTimers): { call(): void; flush(): void; cancel(): void; readonly pending: boolean } {
  let handle: unknown;
  let pending = false;
  return {
    call() {
      if (pending) timers.clearTimeout(handle);
      pending = true;
      handle = timers.setTimeout(() => {
        pending = false;
        fn();
      }, ms);
    },
    flush() {
      if (!pending) return;
      timers.clearTimeout(handle);
      pending = false;
      fn();
    },
    cancel() {
      if (pending) timers.clearTimeout(handle);
      pending = false;
    },
    get pending() {
      return pending;
    },
  };
}

/**
 * Calls `save` with the live state per scope after each quiet period in which
 * a live key changed (selection, camera, visibility, sections, explode, ...).
 * Facts (loading, quality) and presentation (named views) never trigger it.
 * Returns `flush` (call it when the page hides) and `stop`.
 */
export function watchLiveState(store: ViewStore, save: (file: ViewerStateFile) => void, options: { ms?: number; timers?: Timers } = {}): { flush(): void; stop(): void } {
  let last = JSON.stringify(viewerStateFile(store.liveByScope(), store.get().scope));
  const run = () => {
    const file = viewerStateFile(store.liveByScope(), store.get().scope);
    const text = JSON.stringify(file);
    if (text === last) return;
    last = text;
    try {
      save(file);
    } catch (e) {
      console.warn("[view-state] the host could not take the live state", e);
    }
  };
  const d = debounce(run, options.ms ?? LIVE_SAVE_MS, options.timers);
  const stop = store.subscribe((c) => {
    if (c.source === "facts") return;
    d.call();
  });
  return {
    flush: () => d.flush(),
    stop: () => {
      d.cancel();
      stop();
    },
  };
}
