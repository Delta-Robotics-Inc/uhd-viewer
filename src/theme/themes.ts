/**
 * The viewer's own themes: neutral dark and light. They carry no brand; a
 * host's brand theme starts from one of these (`defineTheme`) and changes the
 * accent, surfaces or faces it needs.
 */
import { DERIVED, type Theme, type ThemeTokens } from "./tokens";

const FONT_UI = '"Kode Mono", ui-monospace, monospace';
const FONT_LABEL = '"Kode Mono Bold", "Kode Mono", ui-monospace, monospace';
const FONT_MONO = 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

/** DRC health and finding severity read the same in every theme (owner decision, PB-894 §5). */
export const DRC_TOKENS = {
  drcConfigured: "#22c55e",
  drcPartial: "#eed202",
  drcIncompatible: "#ef4444",
  drcUnconfigured: "#6e7681",
  severityError: "#ef4444",
  severityWarning: "#eed202",
  severityInfo: "#38bdf8",
  severityOk: "#22c55e",
} satisfies Partial<ThemeTokens>;

/** Domain and signal colours on dark surfaces. */
export const DARK_DATA_TOKENS = {
  domainElectrical: "#f5a524",
  domainMechanical: "#94a3b8",
  domainPneumatic: "#22d3ee",
  domainHydraulic: "#6366f1",
  domainThermal: "#f43f5e",
  domainNetwork: "#a78bfa",
  domainSoftware: "#34d399",
  domainOther: "#3a3a3a",
  signalPower: "#f97316",
  signalGround: "#78716c",
  signalDigital: "#38bdf8",
  signalAnalog: "#a3e635",
  signalI2c: "#a78bfa",
  signalSpi: "#f472b6",
  signalUart: "#2dd4bf",
  signalCan: "#facc15",
  signalPwm: "#fde68a",
  signalPhase: "#e11d48",
  signalRf: "#e879f9",
  signalOther: "#8b8680",
} satisfies Partial<ThemeTokens>;

/** The same on light surfaces: one step darker, so thin lines keep their contrast. */
export const LIGHT_DATA_TOKENS = {
  domainElectrical: "#d97706",
  domainMechanical: "#64748b",
  domainPneumatic: "#0891b2",
  domainHydraulic: "#4f46e5",
  domainThermal: "#e11d48",
  domainNetwork: "#7c3aed",
  domainSoftware: "#059669",
  domainOther: "#d6d3d1",
  signalPower: "#ea580c",
  signalGround: "#78716c",
  signalDigital: "#0284c7",
  signalAnalog: "#65a30d",
  signalI2c: "#7c3aed",
  signalSpi: "#db2777",
  signalUart: "#0d9488",
  signalCan: "#ca8a04",
  signalPwm: "#b45309",
  signalPhase: "#e11d48",
  signalRf: "#c026d3",
  signalOther: "#a8a29e",
} satisfies Partial<ThemeTokens>;

const FACES = { fontUi: FONT_UI, fontLabel: FONT_LABEL, fontMono: FONT_MONO } satisfies Partial<ThemeTokens>;

export const defaultDark: Theme = {
  id: "default-dark",
  label: "Default dark",
  scheme: "dark",
  tokens: {
    ...(DERIVED as ThemeTokens),
    background: "oklch(0.2178 0 0)",
    canvas: "oklch(0.2178 0 0)",
    canvasDot: "#2e2e2e",
    surface: "oklch(0.251 0 0)",
    surfaceRaised: "oklch(0.2435 0 0)",
    surfaceSunken: "#191919",
    overlay: "#1f1f1fee",
    scrim: "#0d0d0dcc",
    muted: "oklch(0.285 0 0)",
    active: "oklch(0.3715 0 0)",
    node: "#2f2f2f",
    nodeSelected: "#1f1f1f",
    group: "#94a3b808",
    preview: "#ffffff",
    drawing: "#141414",
    text: "oklch(0.8853 0 0)",
    textMuted: "oklch(0.68 0 0)",
    textFaint: "#6b6560",
    textOnAccent: "oklch(0.98 0 0)",
    textLink: "var(--uhd-accent)",
    border: "oklch(0.329 0 0)",
    borderSubtle: "#2a2a2a",
    borderStrong: "#57534e",
    nodeBorder: "#44403c",
    nodeBorderHover: "#d6d3d1",
    groupBorder: "#6b7280",
    contrastBorder: "transparent",
    contrastActiveBorder: "transparent",
    accent: "oklch(0.68 0.15 245)",
    highlight: "#22d3ee",
    ...DARK_DATA_TOKENS,
    ...DRC_TOKENS,
    sceneBackground: "#1a1a1a",
    sceneGrid: "#3a3a3a",
    sceneGridMinor: "#262626",
    radius: "8px",
    shadowSm: "0px 2px 0px 0px hsl(0 0% 20% / 0.15), 0px 1px 2px -1px hsl(0 0% 20% / 0.15)",
    shadowMd: "0px 2px 0px 0px hsl(0 0% 0% / 0.35), 0px 2px 4px -1px hsl(0 0% 0% / 0.35)",
    shadowLg: "0px 2px 0px 0px hsl(0 0% 0% / 0.35), 0px 4px 6px -1px hsl(0 0% 0% / 0.35)",
    ...FACES,
  },
};

export const defaultLight: Theme = {
  id: "default-light",
  label: "Default light",
  scheme: "light",
  tokens: {
    ...(DERIVED as ThemeTokens),
    background: "#f5f5f4",
    canvas: "#fafaf9",
    canvasDot: "#d6d3d1",
    surface: "#ffffff",
    surfaceRaised: "#ffffff",
    surfaceSunken: "#f5f5f4",
    overlay: "#ffffffee",
    scrim: "#1c191766",
    muted: "#f0efee",
    hover: "color-mix(in oklab, var(--uhd-text) 5%, transparent)",
    active: "#e7e5e4",
    node: "#ffffff",
    nodeSelected: "color-mix(in oklab, var(--uhd-accent) 6%, #ffffff)",
    group: "#64748b0a",
    preview: "#ffffff",
    drawing: "#1c1c1c",
    text: "#1c1917",
    textMuted: "#57534e",
    textFaint: "#8a8580",
    textOnAccent: "#ffffff",
    textLink: "var(--uhd-accent)",
    border: "#e2e0de",
    borderSubtle: "#ecebe9",
    borderStrong: "#a8a29e",
    nodeBorder: "#d6d3d1",
    nodeBorderHover: "#57534e",
    groupBorder: "#94a3b8",
    contrastBorder: "transparent",
    contrastActiveBorder: "transparent",
    accent: "oklch(0.55 0.17 250)",
    highlight: "#0891b2",
    ...LIGHT_DATA_TOKENS,
    ...DRC_TOKENS,
    sceneBackground: "#ececea",
    sceneGrid: "#c4c2c0",
    sceneGridMinor: "#dcdad8",
    radius: "8px",
    shadowSm: "0px 1px 2px 0px hsl(0 0% 0% / 0.06)",
    shadowMd: "0px 1px 2px 0px hsl(0 0% 0% / 0.08), 0px 2px 6px -1px hsl(0 0% 0% / 0.08)",
    shadowLg: "0px 2px 4px 0px hsl(0 0% 0% / 0.08), 0px 6px 16px -2px hsl(0 0% 0% / 0.12)",
    ...FACES,
  },
};

/** The theme a scheme falls back to. */
export const defaultTheme = (scheme: "dark" | "light" = "dark"): Theme => (scheme === "light" ? defaultLight : defaultDark);
