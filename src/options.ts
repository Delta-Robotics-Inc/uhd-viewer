/**
 * How a host's option changes apply (ViewerHandle.update). Kept apart from
 * mount.tsx so it can be tested without a page.
 */
import type { ViewerLayout, ViewerOptions, ViewerViewport } from "./api";

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

/** The same saved viewports, whatever order their levels come in (a host passing back what the viewer sent is not a change). */
export function sameViewports(a: Record<string, ViewerViewport> | undefined, b: Record<string, ViewerViewport> | undefined): boolean {
  const key = (v: Record<string, ViewerViewport> | undefined) =>
    JSON.stringify(
      Object.keys(v ?? {})
        .sort()
        .map((k) => [k, v![k]?.x, v![k]?.y, v![k]?.zoom]),
    );
  return key(a) === key(b);
}

/**
 * What a host's `viewports` option asks of a mounted viewer (PB-1037):
 * `replace` when the viewer must take them (the host passed viewports it was
 * not sent, or it took over keeping them, or gave that up), `keep` otherwise.
 * `known` is what the host has: what it passed last or what it was last sent.
 */
export function hostViewportsChange(o: {
  hosted: boolean;
  wasHosted: boolean;
  host: Record<string, ViewerViewport> | undefined;
  known: Record<string, ViewerViewport> | undefined;
}): "replace" | "keep" {
  if (o.hosted !== o.wasHosted) return "replace";
  if (!o.hosted) return "keep";
  return sameViewports(o.host, o.known) ? "keep" : "replace";
}
