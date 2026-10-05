/**
 * The viewer's theme-token contract: every colour, surface, shadow and face
 * the viewer draws with is one of these semantic tokens, read as a CSS
 * variable (`--uhd-<kebab-name>`). Nothing in the viewer's styles names a raw
 * colour; a host restyles the viewer by giving these tokens values (a theme),
 * never by overriding class rules.
 *
 * A theme is plain data (`Theme`). Values may be any CSS value, including
 * `var(...)` references to the host's own variables (the VS Code adapter maps
 * every token onto `--vscode-*`) and `color-mix(...)` of other tokens.
 *
 * Nothing here names a host product: hosts bring their own themes through
 * `defineTheme` (or a `ThemeAdapter`, ./adapters.ts).
 */

/** Every token, grouped as the contract documents them. */
export interface ThemeTokens {
  // ---- surfaces ---------------------------------------------------------
  /** The page behind everything (the app shell). */
  background: string;
  /** The diagram canvas. */
  canvas: string;
  /** The canvas's dot grid. */
  canvasDot: string;
  /** Panels and floating cards (inspector, legend, toolbars). */
  surface: string;
  /** Popovers, menus and tooltips above a surface. */
  surfaceRaised: string;
  /** Wells inside a surface: inputs, code, table bands, drawing frames. */
  surfaceSunken: string;
  /** Floating chrome laid over the canvas (translucent surface). */
  overlay: string;
  /** Behind a modal view (dims the canvas). */
  scrim: string;
  /** Muted fill (chips, progress tracks). */
  muted: string;
  /** Hover fill on a control or row. */
  hover: string;
  /** Pressed / active fill on a control. */
  active: string;
  /** A module card on the canvas. */
  node: string;
  /** A selected module card. */
  nodeSelected: string;
  /** A group container's fill. */
  group: string;
  /** Behind artifact image previews (most part drawings are made for paper). */
  preview: string;
  /** Behind board drawings (PCB layers). */
  drawing: string;

  // ---- text -------------------------------------------------------------
  text: string;
  textMuted: string;
  textFaint: string;
  /** Text on an accent fill. */
  textOnAccent: string;
  /** A link-like text button. */
  textLink: string;

  // ---- borders ----------------------------------------------------------
  border: string;
  borderSubtle: string;
  borderStrong: string;
  /** A module card's outline. */
  nodeBorder: string;
  /** A module card's outline under the pointer. */
  nodeBorderHover: string;
  /** A group container's dashed outline. */
  groupBorder: string;
  /** Extra outline drawn around every control in a high-contrast theme (transparent otherwise). */
  contrastBorder: string;
  /** Outline of the active / selected control in a high-contrast theme (transparent otherwise). */
  contrastActiveBorder: string;

  // ---- accents ----------------------------------------------------------
  /** The one accent: selection, active toggles, the focused link. */
  accent: string;
  accentHover: string;
  /** A light wash of the accent (an active tab, a selected row). */
  accentTint: string;
  /** The accent's glow around a selected card. */
  accentGlow: string;
  /** A second highlight, distinct from the accent (a counterpart, an interface). */
  highlight: string;

  // ---- focus and selection ------------------------------------------------
  /** Keyboard focus outline. */
  focusRing: string;
  /** A selected row's or item's fill. */
  selection: string;
  /** Text on a selected row. */
  selectionText: string;

  // ---- domains (D7) -----------------------------------------------------
  domainElectrical: string;
  domainMechanical: string;
  domainPneumatic: string;
  domainHydraulic: string;
  domainThermal: string;
  domainNetwork: string;
  domainSoftware: string;
  /** Items outside the classification's focus (signal mode's other domains). */
  domainOther: string;

  // ---- signal types -----------------------------------------------------
  signalPower: string;
  signalGround: string;
  signalDigital: string;
  signalAnalog: string;
  signalI2c: string;
  signalSpi: string;
  signalUart: string;
  signalCan: string;
  signalPwm: string;
  signalPhase: string;
  signalRf: string;
  signalOther: string;

  // ---- DRC health and severity (kept the same in every theme) -------------
  drcConfigured: string;
  drcPartial: string;
  drcIncompatible: string;
  drcUnconfigured: string;
  severityError: string;
  severityWarning: string;
  severityInfo: string;
  severityOk: string;

  // ---- scrollbars ---------------------------------------------------------
  scrollbarThumb: string;
  scrollbarThumbHover: string;

  // ---- the 3D scene -------------------------------------------------------
  sceneBackground: string;
  sceneGrid: string;
  sceneGridMinor: string;

  // ---- shape and type -----------------------------------------------------
  radius: string;
  shadowSm: string;
  shadowMd: string;
  shadowLg: string;
  /** Interface text (labels, buttons, values). */
  fontUi: string;
  /** Display face for headings and card titles. */
  fontLabel: string;
  /** Code, ids and numbers. */
  fontMono: string;
}

export type ThemeToken = keyof ThemeTokens;

/** Light or dark surfaces, and whether the host asks for high contrast. */
export type ThemeScheme = "dark" | "light" | "high-contrast" | "high-contrast-light";

export interface Theme {
  /** A stable id (`default-dark`, `vscode`, a host's own). */
  id: string;
  /** For people choosing a theme. */
  label: string;
  scheme: ThemeScheme;
  tokens: ThemeTokens;
}

/** The CSS variable of a token: `textMuted` → `--uhd-text-muted`. */
export const tokenVar = (token: ThemeToken): string => `--uhd-${token.replace(/[A-Z0-9]+/g, (m) => `-${m.toLowerCase()}`)}`;

/** `var(--uhd-…)` for a token, to use in inline styles and SVG attributes. */
export const token = (name: ThemeToken): string => `var(${tokenVar(name)})`;

/** Every token name, in contract order (used by tests, adapters and docs). */
export const TOKEN_NAMES: readonly ThemeToken[] = [
  "background", "canvas", "canvasDot", "surface", "surfaceRaised", "surfaceSunken", "overlay", "scrim", "muted", "hover", "active",
  "node", "nodeSelected", "group", "preview", "drawing",
  "text", "textMuted", "textFaint", "textOnAccent", "textLink",
  "border", "borderSubtle", "borderStrong", "nodeBorder", "nodeBorderHover", "groupBorder", "contrastBorder", "contrastActiveBorder",
  "accent", "accentHover", "accentTint", "accentGlow", "highlight",
  "focusRing", "selection", "selectionText",
  "domainElectrical", "domainMechanical", "domainPneumatic", "domainHydraulic", "domainThermal", "domainNetwork", "domainSoftware", "domainOther",
  "signalPower", "signalGround", "signalDigital", "signalAnalog", "signalI2c", "signalSpi", "signalUart", "signalCan", "signalPwm", "signalPhase", "signalRf", "signalOther",
  "drcConfigured", "drcPartial", "drcIncompatible", "drcUnconfigured", "severityError", "severityWarning", "severityInfo", "severityOk",
  "scrollbarThumb", "scrollbarThumbHover",
  "sceneBackground", "sceneGrid", "sceneGridMinor",
  "radius", "shadowSm", "shadowMd", "shadowLg", "fontUi", "fontLabel", "fontMono",
];

/** A wash of another token: `mix("accent", 15)` is the accent at 15 % over transparent. */
export const mix = (name: ThemeToken, percent: number, over = "transparent"): string => `color-mix(in oklab, ${token(name)} ${percent}%, ${over})`;

/**
 * Tokens that follow from others unless a theme sets them: the accent's tint
 * and glow, hover and active washes of the text colour, the selection. A
 * theme that sets only the accent still gets a coherent set.
 */
export const DERIVED: Partial<ThemeTokens> = {
  accentHover: `color-mix(in oklab, ${token("accent")} 88%, ${token("text")})`,
  accentTint: mix("accent", 15),
  accentGlow: mix("accent", 25),
  hover: mix("text", 6),
  active: mix("text", 10),
  selection: mix("accent", 15),
  selectionText: token("text"),
  focusRing: token("accent"),
  scrollbarThumb: mix("text", 22),
  scrollbarThumbHover: mix("text", 38),
  overlay: `color-mix(in oklab, ${token("surface")} 92%, transparent)`,
  scrim: "color-mix(in oklab, black 55%, transparent)",
};

/**
 * A complete theme from a base and the tokens that change. Derived tokens
 * (DERIVED) are recomputed from the result unless `tokens` sets them.
 */
export function defineTheme(base: Theme, change: { id: string; label: string; scheme?: ThemeScheme; tokens?: Partial<ThemeTokens> }): Theme {
  return { id: change.id, label: change.label, scheme: change.scheme ?? base.scheme, tokens: { ...base.tokens, ...change.tokens } };
}

/** The CSS declarations of a theme (`--uhd-x: value;` …), for a stylesheet or an inline style. */
export function themeDeclarations(theme: Theme): string {
  return TOKEN_NAMES.map((t) => `${tokenVar(t)}: ${theme.tokens[t]};`).join("\n");
}

/** A stylesheet rule applying a theme under `selector`. */
export const themeCss = (theme: Theme, selector = ":root"): string => `${selector} {\n  color-scheme: ${theme.scheme.includes("light") ? "light" : "dark"};\n  ${themeDeclarations(theme).replace(/\n/g, "\n  ")}\n}\n`;

/**
 * Applies a theme to an element: every token as an inline CSS variable, and
 * `data-uhd-theme` / `data-uhd-scheme` for rules that differ by scheme (high
 * contrast draws thicker outlines). Returns a function that removes it.
 */
export function applyTheme(element: HTMLElement, theme: Theme): () => void {
  for (const t of TOKEN_NAMES) element.style.setProperty(tokenVar(t), theme.tokens[t]);
  element.style.colorScheme = theme.scheme.includes("light") ? "light" : "dark";
  element.dataset.uhdTheme = theme.id;
  element.dataset.uhdScheme = theme.scheme;
  return () => {
    for (const t of TOKEN_NAMES) element.style.removeProperty(tokenVar(t));
    element.style.colorScheme = "";
    delete element.dataset.uhdTheme;
    delete element.dataset.uhdScheme;
  };
}

/** A token's resolved value on an element (for canvases that cannot read CSS: the 3D scene). */
export function readToken(element: Element, name: ThemeToken): string {
  return getComputedStyle(element).getPropertyValue(tokenVar(name)).trim();
}
