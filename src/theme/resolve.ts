/** A host's `theme` option (api.ts) as a theme adapter. */
import type { ViewerThemeOption } from "../api";
import { defaultThemeAdapter, staticTheme, vscodeThemeAdapter, type ThemeAdapter } from "./adapters";
import { defaultDark, defaultLight } from "./themes";
import { TOKEN_NAMES, type Theme, type ThemeTokens } from "./tokens";

/** A theme given with some tokens: the rest from the default of its scheme. */
export function completeTheme(theme: { id: string; label: string; scheme: Theme["scheme"]; tokens: Partial<Record<string, string>> }): Theme {
  const base = theme.scheme.includes("light") ? defaultLight : defaultDark;
  const tokens = { ...base.tokens } as ThemeTokens;
  for (const t of TOKEN_NAMES) if (typeof theme.tokens[t] === "string") tokens[t] = theme.tokens[t]!;
  return { id: theme.id, label: theme.label, scheme: theme.scheme, tokens };
}

/** The theme a person asked for in the page's URL (`?theme=dark|light|system`; `paper` is `light`), if any. */
export type ThemePreference = "dark" | "light" | "system";

/**
 * The explicit override (PB-1189): `?theme=` in the page URL. The view state now carries a `theme` field (gate 3,
 * `ViewState.theme`, live and per user), but the theme here is resolved once from the host option and the URL:
 * switching on a view-state write needs the theme provider to subscribe to the view hub (a wave 4 item, noted in
 * wave-3-review.md). Until then this is the override.
 */
export function themeFromUrl(search: string | undefined = typeof location === "undefined" ? undefined : location.search): ThemePreference | undefined {
  if (!search) return undefined;
  const v = new URLSearchParams(search).get("theme")?.toLowerCase();
  if (v === "dark" || v === "light" || v === "system") return v;
  if (v === "paper") return "light";
  return undefined;
}

/**
 * - an explicit `?theme=` in the URL wins over everything below (themeFromUrl);
 * - absent: the system's preference (`prefers-color-scheme`) on the web, the
 *   dark theme where there is none (node, tests) (PB-1189, DEFAULT: it was
 *   always dark); `"dark"` / `"light"`: the anatomy dark or paper theme;
 *   `"system"`: whichever the system prefers;
 * - `"vscode"`: the VS Code adapter (in a VS Code webview);
 * - a theme object: that theme (missing tokens from the default);
 * - an adapter (`{ current, subscribe? }`): the host's own.
 */
export function resolveTheme(option: ViewerThemeOption | undefined, url: ThemePreference | undefined = themeFromUrl()): ThemeAdapter {
  if (url === "dark") return staticTheme(defaultDark);
  if (url === "light") return staticTheme(defaultLight);
  if (url === "system") return defaultThemeAdapter("system");
  if (!option) return defaultThemeAdapter("system");
  if (option === "dark") return staticTheme(defaultDark);
  if (option === "light") return staticTheme(defaultLight);
  if (option === "system") return defaultThemeAdapter("system");
  if (option === "vscode") return vscodeThemeAdapter();
  if ("current" in option) {
    const adapter = option;
    return {
      id: adapter.id,
      current: () => completeTheme(adapter.current()),
      subscribe: adapter.subscribe ? (onChange) => adapter.subscribe!((t) => onChange(completeTheme(t))) : undefined,
    };
  }
  return staticTheme(completeTheme(option));
}
