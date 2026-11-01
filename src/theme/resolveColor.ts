/**
 * A token's value on an element, for drawing that cannot read CSS (the 3D scene, PB-1189): colours resolved to
 * `#rrggbb` whatever CSS form the theme used (`oklch()`, `color-mix()`, `var(--vscode-…)`), lengths as written.
 * No React: the scene module imports it.
 */
import { tokenVar, type ThemeToken } from "./tokens";

let probe: CanvasRenderingContext2D | null | undefined;

/** The token's colour as `#rrggbb` (alpha dropped), or undefined where there is no DOM or no value. */
export function resolveTokenColor(element: Element | null | undefined, name: ThemeToken): string | undefined {
  if (!element || typeof document === "undefined" || typeof getComputedStyle === "undefined") return undefined;
  const raw = getComputedStyle(element).getPropertyValue(tokenVar(name)).trim();
  if (!raw) return undefined;
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
  const span = document.createElement("span");
  span.style.color = `var(${tokenVar(name)})`;
  span.style.display = "none";
  element.appendChild(span);
  const css = getComputedStyle(span).color;
  span.remove();
  if (!css) return undefined;
  if (probe === undefined) probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!probe) return undefined;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "#000";
  probe.fillStyle = css;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** The token's raw value (a length such as `1px`), or undefined. */
export function resolveTokenValue(element: Element | null | undefined, name: ThemeToken): string | undefined {
  if (!element || typeof getComputedStyle === "undefined") return undefined;
  return getComputedStyle(element).getPropertyValue(tokenVar(name)).trim() || undefined;
}
