/** React access to the view store: a slice re-renders only when it changes (the store replaces only what a write touched). */
import { useCallback, useSyncExternalStore } from "react";
import type { ViewStore } from "./store";
import type { ViewState } from "./schema";

export function useViewSlice<T>(store: ViewStore, select: (s: ViewState) => T): T {
  const subscribe = useCallback((cb: () => void) => store.subscribe(() => cb()), [store]);
  return useSyncExternalStore(
    subscribe,
    () => select(store.get()),
    () => select(store.get()),
  );
}
