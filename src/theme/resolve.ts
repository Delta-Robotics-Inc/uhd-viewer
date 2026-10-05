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

/**
 * - absent or `"dark"` / `"light"`: the viewer's own dark (as it has always
 *   looked) or light theme; `"system"`: whichever the system prefers;
 * - `"vscode"`: the VS Code adapter (in a VS Code webview);
 * - a theme object: that theme (missing tokens from the default);
 * - an adapter (`{ current, subscribe? }`): the host's own.
 */
export function resolveTheme(option: ViewerThemeOption | undefined): ThemeAdapter {
  if (!option || option === "dark") return staticTheme(defaultDark);
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
