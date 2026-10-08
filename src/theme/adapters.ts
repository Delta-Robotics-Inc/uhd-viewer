/**
 * Theme adapters: where a host's theme comes from, and when it changes. The
 * viewer asks its adapter for the current theme and re-applies it when the
 * adapter says it changed; the views never need rebuilding for a host.
 *
 * - `staticTheme(theme)`: one fixed theme (a host's brand theme).
 * - `defaultThemeAdapter()`: the viewer's neutral dark and light themes,
 *   following the system's colour scheme unless one is given.
 * - `vscodeThemeAdapter()`: every token mapped onto the `--vscode-*`
 *   variables a VS Code webview receives, following the active colour theme
 *   (dark, light, high contrast dark and light) as VS Code switches it.
 */
import { DRC_TOKENS, DARK_DATA_TOKENS, LIGHT_DATA_TOKENS, defaultDark, defaultLight } from "./themes";
import { mix, type Theme, type ThemeScheme, type ThemeTokens } from "./tokens";

export interface ThemeAdapter {
  id: string;
  /** The theme to show now. */
  current(): Theme;
  /** Calls `onChange` whenever the theme changes; returns the unsubscribe. Absent: the theme never changes. */
  subscribe?(onChange: (theme: Theme) => void): () => void;
}

/** One fixed theme. */
export const staticTheme = (theme: Theme): ThemeAdapter => ({ id: theme.id, current: () => theme });

/** Several adapters' worth of themes, picked by id (a host's theme switcher). */
export function pickTheme(themes: readonly Theme[], id: string | null | undefined, fallback: Theme): Theme {
  return themes.find((t) => t.id === id) ?? fallback;
}

/** The viewer's own themes: dark, light, or the system's preference (default). */
export function defaultThemeAdapter(scheme: "dark" | "light" | "system" = "system", win: Window | undefined = typeof window === "undefined" ? undefined : window): ThemeAdapter {
  const query = scheme === "system" ? win?.matchMedia?.("(prefers-color-scheme: light)") : undefined;
  const current = () => (scheme === "light" || (scheme === "system" && query?.matches) ? defaultLight : defaultDark);
  return {
    id: "default",
    current,
    subscribe: query
      ? (onChange) => {
          const h = () => onChange(current());
          query.addEventListener("change", h);
          return () => query.removeEventListener("change", h);
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// VS Code
// ---------------------------------------------------------------------------

/** `var(--vscode-<name>, <fallback>)` (a VS Code theme may leave any colour unset). */
const vs = (name: string, fallback: string) => `var(--vscode-${name}, ${fallback})`;

/** The scheme of a VS Code webview, from the class VS Code puts on its body. */
export function vscodeScheme(body: { classList: { contains(c: string): boolean } } | undefined): ThemeScheme {
  if (!body) return "dark";
  if (body.classList.contains("vscode-high-contrast-light")) return "high-contrast-light";
  if (body.classList.contains("vscode-high-contrast")) return "high-contrast";
  if (body.classList.contains("vscode-light")) return "light";
  return "dark";
}

/** The VS Code tokens for one scheme. */
export function vscodeTheme(scheme: ThemeScheme): Theme {
  const light = scheme === "light" || scheme === "high-contrast-light";
  const hc = scheme.startsWith("high-contrast");
  const base = light ? defaultLight : defaultDark;
  const data = light ? LIGHT_DATA_TOKENS : DARK_DATA_TOKENS;
  const editor = vs("editor-background", base.tokens.canvas);
  const fg = vs("foreground", base.tokens.text);
  const widget = vs("editorWidget-background", base.tokens.surface);
  const widgetBorder = vs("editorWidget-border", base.tokens.border);
  const tokens: ThemeTokens = {
    ...base.tokens,
    background: editor,
    canvas: editor,
    canvasDot: `color-mix(in oklab, ${fg} 14%, ${editor})`,
    surface: vs("sideBar-background", widget),
    surfaceRaised: vs("menu-background", widget),
    surfaceSunken: vs("input-background", base.tokens.surfaceSunken),
    overlay: `color-mix(in oklab, ${widget} 94%, transparent)`,
    scrim: `color-mix(in oklab, ${editor} 70%, transparent)`,
    muted: vs("input-background", base.tokens.muted),
    hover: vs("toolbar-hoverBackground", vs("list-hoverBackground", base.tokens.hover)),
    active: vs("toolbar-activeBackground", vs("list-inactiveSelectionBackground", base.tokens.active)),
    node: `color-mix(in oklab, ${fg} 5%, ${widget})`,
    nodeSelected: vs("list-inactiveSelectionBackground", base.tokens.nodeSelected),
    group: mix("text", 3),
    text: fg,
    textMuted: vs("descriptionForeground", base.tokens.textMuted),
    textFaint: vs("disabledForeground", base.tokens.textFaint),
    textOnAccent: vs("button-foreground", base.tokens.textOnAccent),
    textLink: vs("textLink-foreground", base.tokens.accent),
    border: vs("widget-border", vs("panel-border", base.tokens.border)),
    borderSubtle: vs("editorGroup-border", base.tokens.borderSubtle),
    borderStrong: widgetBorder,
    nodeBorder: widgetBorder,
    nodeBorderHover: vs("focusBorder", base.tokens.nodeBorderHover),
    groupBorder: vs("descriptionForeground", base.tokens.groupBorder),
    contrastBorder: vs("contrastBorder", "transparent"),
    contrastActiveBorder: vs("contrastActiveBorder", "transparent"),
    accent: hc ? vs("focusBorder", vs("contrastActiveBorder", base.tokens.accent)) : vs("button-background", base.tokens.accent),
    accentHover: hc ? vs("focusBorder", base.tokens.accent) : vs("button-hoverBackground", base.tokens.accent),
    highlight: vs("terminal-ansiCyan", base.tokens.highlight),
    focusRing: vs("focusBorder", base.tokens.accent),
    selection: vs("list-activeSelectionBackground", base.tokens.selection),
    selectionText: vs("list-activeSelectionForeground", fg),
    ...data,
    ...DRC_TOKENS,
    scrollbarThumb: vs("scrollbarSlider-background", base.tokens.scrollbarThumb),
    scrollbarThumbHover: vs("scrollbarSlider-hoverBackground", base.tokens.scrollbarThumbHover),
    sceneBackground: editor,
    sceneGrid: `color-mix(in oklab, ${fg} 22%, ${editor})`,
    sceneGridMinor: `color-mix(in oklab, ${fg} 9%, ${editor})`,
    radius: "4px",
    shadowSm: `0 1px 2px ${vs("widget-shadow", "rgb(0 0 0 / 0.2)")}`,
    shadowMd: `0 2px 8px ${vs("widget-shadow", "rgb(0 0 0 / 0.3)")}`,
    shadowLg: `0 4px 16px ${vs("widget-shadow", "rgb(0 0 0 / 0.36)")}`,
  };
  if (hc) {
    // high contrast: no washes; outlines carry state
    Object.assign(tokens, {
      hover: "transparent",
      active: "transparent",
      accentTint: "transparent",
      accentGlow: "transparent",
      selection: "transparent",
      overlay: editor,
      surface: editor,
      surfaceRaised: editor,
      node: editor,
      nodeSelected: editor,
      border: vs("contrastBorder", base.tokens.border),
      nodeBorder: vs("contrastBorder", base.tokens.nodeBorder),
      shadowSm: "none",
      shadowMd: "none",
      shadowLg: "none",
    } satisfies Partial<ThemeTokens>);
  }
  return { id: "vscode", label: "VS Code", scheme, tokens };
}

/**
 * Follows the VS Code colour theme of the webview the viewer runs in: the
 * tokens refer to VS Code's variables, so a colour change inside a scheme
 * needs nothing; a change of scheme (VS Code swaps its body class) re-themes.
 */
export function vscodeThemeAdapter(doc: Document | undefined = typeof document === "undefined" ? undefined : document): ThemeAdapter {
  const current = () => vscodeTheme(vscodeScheme(doc?.body));
  return {
    id: "vscode",
    current,
    subscribe: doc?.body
      ? (onChange) => {
          let scheme = vscodeScheme(doc.body);
          const observer = new MutationObserver(() => {
            const next = vscodeScheme(doc.body);
            if (next !== scheme) {
              scheme = next;
              onChange(current());
            }
          });
          observer.observe(doc.body, { attributes: true, attributeFilter: ["class"] });
          return () => observer.disconnect();
        }
      : undefined,
  };
}
