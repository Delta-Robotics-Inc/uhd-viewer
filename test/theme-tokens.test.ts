/** PB-1189: the anatomy paper and dark token sets, the DRC set's contrast, the theme choice. */
import { describe, expect, it } from "vitest";
import { CONTRAST_GRAPHIC, CONTRAST_TEXT, contrastRatio, luminance, parseHex } from "../src/theme/contrast";
import { DARK_SCENE_TOKENS, PAPER_SCENE_TOKENS, defaultDark, defaultLight } from "../src/theme/themes";
import { resolveTheme, themeFromUrl } from "../src/theme/resolve";
import { vscodeTheme } from "../src/theme/adapters";
import { TOKEN_NAMES, tokenVar } from "../src/theme/tokens";
import { bandFactors, readSceneLook } from "../src/cad/render/toon";

const SETS = { paper: PAPER_SCENE_TOKENS, dark: DARK_SCENE_TOKENS } as const;
const DRC = ["drcError", "drcWarning", "drcInfo", "drcRisk", "drcPass", "drcUnknown"] as const;

describe("WCAG contrast", () => {
  it("computes the reference ratios", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // WCAG's own example pair: #777777 on white is just under 4.5
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(parseHex("#abc")).toEqual(parseHex("#aabbcc"));
    expect(parseHex("oklch(0.5 0 0)")).toBeUndefined();
    expect(luminance([1, 1, 1])).toBeCloseTo(1, 6);
  });
});

describe("the two token sets", () => {
  for (const [name, set] of Object.entries(SETS)) {
    it(`${name}: every DRC colour is at least ${CONTRAST_TEXT}:1 on the scene ground and on a callout card`, () => {
      for (const k of DRC) {
        for (const ground of [set.sceneBackground, set.calloutSurface]) {
          const r = contrastRatio(set[k], ground);
          expect(r, `${name}.${k} ${set[k]} on ${ground}: ${r.toFixed(2)}`).toBeGreaterThanOrEqual(CONTRAST_TEXT);
        }
      }
    });

    it(`${name}: ink, labels and the leader hold their thresholds`, () => {
      const g = set.sceneBackground;
      expect(contrastRatio(set.inkSilhouette, g)).toBeGreaterThanOrEqual(CONTRAST_TEXT);
      expect(contrastRatio(set.inkCrease, g)).toBeGreaterThanOrEqual(CONTRAST_GRAPHIC);
      expect(contrastRatio(set.calloutLeader, g)).toBeGreaterThanOrEqual(CONTRAST_TEXT);
      expect(contrastRatio(set.calloutText, set.calloutSurface)).toBeGreaterThanOrEqual(CONTRAST_TEXT);
      expect(contrastRatio(set.calloutLabel, set.calloutSurface)).toBeGreaterThanOrEqual(CONTRAST_TEXT);
      // the silhouette ink reads against every band of a neutral body, so a part is outlined wherever it is lit
      for (const t of [set.modelToneLit, set.modelToneMid, set.modelToneShade]) expect(contrastRatio(set.inkSilhouette, t)).toBeGreaterThanOrEqual(CONTRAST_GRAPHIC);
    });

    it(`${name}: three bands, lit brightest, close together (matte, not hazard-hard)`, () => {
      const [lit, mid, shade] = [set.modelToneLit, set.modelToneMid, set.modelToneShade].map((h) => luminance(parseHex(h)!));
      expect(lit).toBeGreaterThan(mid);
      expect(mid).toBeGreaterThan(shade);
      // anatomy: close tones. The lit band is never more than 3:1 over the shaded one
      expect(contrastRatio(set.modelToneLit, set.modelToneShade)).toBeLessThan(3);
      const f = bandFactors({ lit: set.modelToneLit, mid: set.modelToneMid, shade: set.modelToneShade });
      expect(f[2]).toBe(1);
      expect(f[0]).toBeLessThan(f[1]);
    });

    it(`${name}: every colour is a hex token (the 3D scene reads them without CSS)`, () => {
      for (const [k, v] of Object.entries(set)) if (!k.endsWith("Width")) expect(parseHex(v), `${name}.${k}`).toBeDefined();
      expect(set.inkWidth).toMatch(/^\d+(\.\d+)?px$/);
      expect(set.calloutLeaderWidth).toMatch(/^\d+(\.\d+)?px$/);
    });
  }

  it("the risk colour is orange and the accent is not (one accent: selection blue, DEFAULT)", () => {
    for (const set of Object.values(SETS)) {
      const [r, g, b] = parseHex(set.drcRisk)!;
      expect(r).toBeGreaterThan(g);
      expect(g).toBeGreaterThan(b);
    }
    expect(defaultDark.tokens.accent).toMatch(/oklch\(0\.68 0\.15 245\)/);
    expect(defaultLight.tokens.accent).toMatch(/oklch\(0\.55 0\.17 250\)/);
  });

  it("the viewer's themes carry the sets, and VS Code takes the set of its theme kind", () => {
    expect(defaultLight.tokens.modelToneLit).toBe(PAPER_SCENE_TOKENS.modelToneLit);
    expect(defaultDark.tokens.drcRisk).toBe(DARK_SCENE_TOKENS.drcRisk);
    expect(vscodeTheme("light").tokens.inkSilhouette).toBe(PAPER_SCENE_TOKENS.inkSilhouette);
    expect(vscodeTheme("dark").tokens.inkSilhouette).toBe(DARK_SCENE_TOKENS.inkSilhouette);
    expect(vscodeTheme("high-contrast-light").tokens.drcError).toBe(PAPER_SCENE_TOKENS.drcError);
    for (const t of ["calloutSurface", "calloutLeader", "drcRisk", "inkSilhouette"] as const) expect(TOKEN_NAMES).toContain(t);
    expect(tokenVar("calloutLeaderWidth")).toBe("--uhd-callout-leader-width");
  });
});

describe("choosing a theme", () => {
  it("reads the URL override", () => {
    expect(themeFromUrl("?theme=dark")).toBe("dark");
    expect(themeFromUrl("?view=3d&theme=paper")).toBe("light");
    expect(themeFromUrl("?theme=system")).toBe("system");
    expect(themeFromUrl("?theme=neon")).toBeUndefined();
    expect(themeFromUrl("")).toBeUndefined();
  });

  it("the URL wins over the host's option; without either, the system's preference (dark where there is none)", () => {
    expect(resolveTheme("dark", "light").current().id).toBe("default-light");
    expect(resolveTheme("light", "dark").current().id).toBe("default-dark");
    expect(resolveTheme("light", undefined).current().id).toBe("default-light");
    // node has no matchMedia: the system adapter falls back to dark
    expect(resolveTheme(undefined, undefined).current().id).toBe("default-dark");
  });
});

describe("the scene's look from tokens", () => {
  it("reads band factors and ink from a token lookup", () => {
    const look = readSceneLook((t) => (DARK_SCENE_TOKENS as Record<string, string>)[t]);
    expect(look.bands[2]).toBe(1);
    expect(look.inkWidth).toBe(1);
    expect(look.silhouette).toBe("#d4d4d4");
    expect(look.neutral).toBe("#333333");
    const fallback = readSceneLook(() => undefined);
    expect(fallback.bands.length).toBe(3);
  });
});
