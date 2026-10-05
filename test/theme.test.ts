/** The theme-token contract and its adapters (PB-900). */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Color } from "three";
import { describe, expect, it } from "vitest";
import { TOKEN_NAMES, defineTheme, themeDeclarations, tokenVar, type ThemeTokens } from "../src/theme/tokens";
import { defaultDark, defaultLight } from "../src/theme/themes";
import { vscodeScheme, vscodeTheme } from "../src/theme/adapters";
import { completeTheme, resolveTheme } from "../src/theme/resolve";
import { DEFAULT_SCENE_ACCENT, sceneColors } from "../src/cad/scene";

const CSS = new URL("../src/styles/theme.css", import.meta.url);
const HEADER = "/* Generated from src/theme/themes.ts (defaultDark) by test/theme.test.ts: UPDATE_THEME_CSS=1 npm test rewrites it. */\n";
// tokens only: no color-scheme on a host page's root
const expected = HEADER + `:where(:root) {\n  ${themeDeclarations(defaultDark).replace(/\n/g, "\n  ")}\n}\n`;

describe("theme tokens", () => {
  it("names every token once, as --uhd-<kebab>", () => {
    expect(new Set(TOKEN_NAMES).size).toBe(TOKEN_NAMES.length);
    expect(tokenVar("textMuted")).toBe("--uhd-text-muted");
    expect(tokenVar("signalI2c")).toBe("--uhd-signal-i2c");
    expect(tokenVar("drcConfigured")).toBe("--uhd-drc-configured");
  });

  it("gives every theme a value for every token", () => {
    for (const theme of [defaultDark, defaultLight, vscodeTheme("dark"), vscodeTheme("light"), vscodeTheme("high-contrast"), vscodeTheme("high-contrast-light")]) {
      expect(Object.keys(theme.tokens).sort(), theme.id).toEqual([...TOKEN_NAMES].sort());
      for (const t of TOKEN_NAMES) expect(theme.tokens[t], `${theme.id}.${t}`).toBeTruthy();
    }
  });

  it("keeps the stylesheet's default tokens equal to the default dark theme", () => {
    if (process.env.UPDATE_THEME_CSS || !existsSync(CSS)) writeFileSync(CSS, expected);
    expect(readFileSync(CSS, "utf8")).toBe(expected);
  });

  it("names no colour of a host product in the viewer's own themes", () => {
    const all = JSON.stringify([defaultDark, defaultLight]).toLowerCase();
    // Protoboard's brand orange (oklch 0.68 0.21 40 / #ff5c00 / #f26b1d) belongs to the host's theme, not here
    expect(all).not.toMatch(/#ff5c00|#f26b1d|0\.6837 0\.212/);
  });

  it("hard-codes no brand colour anywhere in the viewer's source, the 3D scene included", () => {
    const brand = /ff5c00|f26b1d|2a1200|3a1600|0\.6837 0\.212/i;
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(tsx?|css|html|svg)$/.test(e.name) && brand.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    walk(fileURLToPath(new URL("../src", import.meta.url)));
    expect(hits).toEqual([]);
  });

  it("gives each 3D scene its own highlight colours", () => {
    const a = sceneColors({ accent: "#ff0000", highlight: "#00ff00" });
    const b = sceneColors();
    expect(a.focus).toBe(0xff0000);
    expect(b.focus).toBe(new Color(DEFAULT_SCENE_ACCENT).getHex());
    expect(a).not.toBe(b);
  });

  it("keeps DRC severity colours the same in every theme", () => {
    const keys: (keyof ThemeTokens)[] = ["drcConfigured", "drcPartial", "drcIncompatible", "severityError", "severityWarning"];
    for (const k of keys) {
      expect(defaultLight.tokens[k]).toBe(defaultDark.tokens[k]);
      expect(vscodeTheme("high-contrast").tokens[k]).toBe(defaultDark.tokens[k]);
    }
  });

  it("derives a coherent theme from an accent alone", () => {
    const brand = defineTheme(defaultDark, { id: "brand", label: "Brand", tokens: { accent: "tomato" } });
    expect(brand.tokens.accent).toBe("tomato");
    expect(brand.tokens.accentTint).toContain("var(--uhd-accent)");
    expect(brand.tokens.surface).toBe(defaultDark.tokens.surface);
  });
});

describe("the VS Code adapter", () => {
  const body = (...classes: string[]) => ({ classList: { contains: (c: string) => classes.includes(c) } });

  it("reads the scheme from the webview body's class", () => {
    expect(vscodeScheme(body("vscode-dark"))).toBe("dark");
    expect(vscodeScheme(body("vscode-light"))).toBe("light");
    expect(vscodeScheme(body("vscode-high-contrast"))).toBe("high-contrast");
    expect(vscodeScheme(body("vscode-high-contrast", "vscode-high-contrast-light"))).toBe("high-contrast-light");
    expect(vscodeScheme(undefined)).toBe("dark");
  });

  it("maps surfaces, text and focus onto VS Code's variables", () => {
    const t = vscodeTheme("dark").tokens;
    expect(t.canvas).toMatch(/^var\(--vscode-editor-background,/);
    expect(t.text).toMatch(/^var\(--vscode-foreground,/);
    expect(t.focusRing).toMatch(/^var\(--vscode-focusBorder,/);
    expect(t.scrollbarThumb).toMatch(/^var\(--vscode-scrollbarSlider-background,/);
    expect(t.contrastBorder).toBe("var(--vscode-contrastBorder, transparent)");
  });

  it("draws state with outlines, not washes, in high contrast", () => {
    const t = vscodeTheme("high-contrast").tokens;
    expect(t.hover).toBe("transparent");
    expect(t.selection).toBe("transparent");
    expect(t.border).toMatch(/--vscode-contrastBorder/);
    expect(t.accent).toMatch(/--vscode-focusBorder/);
  });
});

describe("the theme option", () => {
  it("defaults to the viewer's dark theme", () => {
    expect(resolveTheme(undefined).current().id).toBe("default-dark");
    expect(resolveTheme("light").current().id).toBe("default-light");
  });

  it("completes a host theme from the default of its scheme", () => {
    const t = completeTheme({ id: "mine", label: "Mine", scheme: "light", tokens: { accent: "teal", bogus: "x" } });
    expect(t.tokens.accent).toBe("teal");
    expect(t.tokens.canvas).toBe(defaultLight.tokens.canvas);
    expect("bogus" in t.tokens).toBe(false);
    expect(resolveTheme({ id: "mine", label: "Mine", scheme: "dark", tokens: {} }).current().tokens.canvas).toBe(defaultDark.tokens.canvas);
  });
});
