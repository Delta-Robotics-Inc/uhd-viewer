/**
 * How a host's option changes apply (ViewerHandle.update). Kept apart from
 * mount.tsx so it can be tested without a page.
 */
import type { ViewerLayout, ViewerOptions } from "./api";

/**
 * The options after `update(change)`: the change is merged into the current
 * options. A change that names `bundleUrl` and not `bundle` switches to
 * loading from that URL (a given `bundle` would otherwise keep precedence).
 */
export function mergeOptions<T extends ViewerOptions>(current: T, change: Partial<ViewerOptions>): T {
  const next = { ...current, ...change };
  if ("bundleUrl" in change && !("bundle" in change)) delete next.bundle;
  return next;
}

/** The same layout edits (a host passing back what the viewer sent is not a change). */
export function sameLayout(a: ViewerLayout | undefined, b: ViewerLayout | undefined): boolean {
  const key = (l: ViewerLayout | undefined) => JSON.stringify({ positions: l?.positions ?? {}, links: l?.links ?? {} });
  return key(a) === key(b);
}
