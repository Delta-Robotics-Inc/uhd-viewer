/**
 * The loading stages (PB-1177): fetch, parse, upload, first frame and ready;
 * the stage line after 1 s and the lighter tiers after 10 s; the pre-flight
 * warning over 20,000 draws or 5 M triangles that waits for a choice and never
 * refuses; failures counted without blocking; the screen's comet geometry.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { LoadTracker, LoadingScreen, MARK_PATH, SCRIM_OPACITY, attachLoadTracker, loadLine, loadMode, preflight, preflightFromSidecars, sidecarCounts, trianglePoint } from "../src/cad/loading";
import type { LoadState } from "../src/cad/render/observe";

function clock() {
  let t = 1000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("loading stages", () => {
  it("goes fetch, parse, upload, first frame, ready, timing each stage", () => {
    const c = clock();
    const tr = new LoadTracker(c.now);
    expect(tr.snapshot()).toMatchObject({ stage: "idle", visible: false });
    tr.push({ type: "begin", files: 3, bytesTotal: 3_000_000 });
    expect(tr.snapshot()).toMatchObject({ stage: "fetch", visible: true, showStage: false, progress: 0 });
    c.advance(1200);
    tr.push({ type: "file", url: "a.glb", bytes: 1_000_000 });
    const s1 = tr.snapshot();
    expect(s1.stage).toBe("fetch");
    expect(s1.showStage).toBe(true);
    expect(s1.message).toBe("Fetching parts (1 of 3, 1.0 MB of 3.0 MB)");
    expect(s1.progress).toBeCloseTo(1 / 3);
    // a repeated event for the same file counts once
    tr.push({ type: "file", url: "a.glb", bytes: 1_000_000 });
    tr.push({ type: "file", url: "b.glb", bytes: 1_000_000, cached: true });
    // the view compiles a body as it arrives: counted, but the stage stays until every file is in
    tr.push({ type: "upload", done: 2, total: 3 });
    expect(tr.snapshot().stage).toBe("fetch");
    c.advance(300);
    tr.push({ type: "file", url: "c.glb", bytes: 1_000_000 });
    expect(tr.snapshot().stage).toBe("parse");
    tr.push({ type: "upload", done: 3, total: 3 });
    expect(tr.snapshot()).toMatchObject({ stage: "upload", message: "Preparing the view", progress: 1 });
    tr.push({ type: "loaded" });
    expect(tr.snapshot().stage).toBe("first-frame");
    c.advance(50);
    const done = tr.push({ type: "frame" });
    expect(done).toMatchObject({ stage: "ready", visible: false, files: { total: 3, fetched: 3, parsed: 3, failed: 0, cached: 1 } });
    expect(done.timings.fetch).toBe(1500);
    expect(done.timings["first-frame"]).toBe(50);
    expect(loadLine(done)).toContain("3/3 files");
    // late events after ready change nothing
    tr.push({ type: "file", url: "d.glb", bytes: 5 });
    expect(tr.snapshot().files.fetched).toBe(3);
  });

  it("takes the view's count of models arrived when placements share files", () => {
    const tr = new LoadTracker(clock().now);
    tr.push({ type: "begin", files: 4 });
    tr.push({ type: "file", url: "screw.glb", bytes: 100 });
    tr.push({ type: "file", url: "screw.glb", bytes: 100, cached: true });
    tr.push({ type: "counts", total: 4, done: 3, failed: 0 });
    expect(tr.snapshot()).toMatchObject({ stage: "fetch", files: { fetched: 3 }, bytes: { done: 100 } });
    tr.push({ type: "counts", total: 4, done: 4, failed: 0 });
    expect(tr.snapshot().stage).toBe("parse");
  });

  it("counts a failed part and still opens the view", () => {
    const tr = new LoadTracker(clock().now);
    tr.push({ type: "begin", files: 2 });
    tr.push({ type: "file", url: "a.glb", bytes: 10 });
    tr.push({ type: "failed", url: "b.glb" });
    tr.push({ type: "counts", total: 2, done: 1, failed: 1 });
    tr.push({ type: "loaded" });
    const s = tr.push({ type: "frame" });
    expect(s.stage).toBe("ready");
    expect(s.message).toBe("1 part(s) could not be read. The rest are shown.");
    expect(s.failedUrls).toEqual(["b.glb"]);
  });

  it("offers boxes or coarse after 10 s of waiting", () => {
    const c = clock();
    const tr = new LoadTracker(c.now);
    tr.push({ type: "begin", files: 50 });
    expect(tr.snapshot().offerLighter).toBe(false);
    c.advance(10_500);
    expect(tr.snapshot().offerLighter).toBe(true);
    tr.push({ type: "choose", tier: "coarse" });
    expect(tr.snapshot()).toMatchObject({ tier: "coarse", choice: "coarse", offerLighter: false });
  });

  it("warns over the pre-flight limits and waits for a choice, never refusing", () => {
    const heavy = preflight([sidecarCounts({ tiers: { fine: { draws: 39, triangles: 751_276 }, coarse: { triangles: 515_559 } } }, 8), { draws: 25_000, triangles: 10 }]);
    expect(heavy.over).toBe(true);
    expect(heavy.draws).toBe(39 * 8 + 25_000);
    expect(heavy.reasons).toEqual(["25,312 draw calls (limit 20,000)", "6,010,218 triangles (limit 5,000,000)"]);
    expect(heavy.coarseTriangles).toBe(515_559 * 8 + 10);
    const light = preflight([{ draws: 48, triangles: 870_860 }]);
    expect(light).toMatchObject({ over: false, reasons: [] });

    const tr = new LoadTracker(clock().now);
    tr.push({ type: "preflight", preflight: heavy });
    tr.push({ type: "begin", files: 9 });
    const s = tr.snapshot();
    expect(s.stage).toBe("preflight");
    expect(s.offerLighter).toBe(true);
    expect(s.message).toContain("This model is large: 25,312 draw calls");
    // "Load it all" goes on with the full model
    tr.push({ type: "choose", tier: "fine" });
    expect(tr.snapshot()).toMatchObject({ stage: "fetch", tier: "fine" });
  });

  it("reads the pre-flight counts from the view sidecars beside the GLBs", async () => {
    const files: Record<string, unknown> = { "/m/a.view.json": { tiers: { fine: { draws: 11, triangles: 1000 } } } };
    const fake = (async (url: string) => (files[url] ? new Response(JSON.stringify(files[url])) : new Response("", { status: 404 }))) as unknown as typeof fetch;
    const p = await preflightFromSidecars(new Map([["/m/a.glb", 2], ["/m/b.glb", 1]]), fake);
    expect(p).toMatchObject({ draws: 22, triangles: 2000, over: false });
  });
});

describe("loading screen", () => {
  it("shows the title, the stage and a bar while loading, and nothing once ready", () => {
    const c = clock();
    const tr = new LoadTracker(c.now);
    tr.push({ type: "begin", files: 2 });
    c.advance(2000);
    const html = renderToStaticMarkup(createElement(LoadingScreen, { state: tr.snapshot() }));
    // R1-B (B3): plain words, no file names
    expect(html).toContain("Loading model");
    expect(html).not.toContain("Getting your model ready");
    expect(html).toContain("Fetching parts (0 of 2)");
    expect(html).toContain('data-stage="fetch"');
    expect(html).toContain("cad-loading-dot");
    tr.push({ type: "file", url: "a", bytes: 1 });
    tr.push({ type: "file", url: "b", bytes: 1 });
    tr.push({ type: "loaded" });
    tr.push({ type: "frame" });
    expect(renderToStaticMarkup(createElement(LoadingScreen, { state: tr.snapshot() }))).toBe("");
  });

  it("offers the lighter tiers only when asked to choose", () => {
    const tr = new LoadTracker(clock().now);
    tr.push({ type: "preflight", preflight: preflight([{ draws: 70_000, triangles: 2_000_000 }]) });
    tr.push({ type: "begin", files: 1 });
    const withChoice = renderToStaticMarkup(createElement(LoadingScreen, { state: tr.snapshot(), onChoose: () => {} }));
    expect(withChoice).toContain("Load coarse");
    expect(withChoice).toContain("Show boxes");
    expect(withChoice).toContain("Load it all");
    expect(renderToStaticMarkup(createElement(LoadingScreen, { state: tr.snapshot() }))).not.toContain("Load coarse");
  });

  it("walks the comet round the triangle by length", () => {
    expect(trianglePoint(0)).toEqual([81.2, 83.78]);
    const p = trianglePoint(0.5);
    expect(p[0]).toBeGreaterThan(11);
    expect(p[0]).toBeLessThan(89);
    expect(trianglePoint(1)).toEqual(trianglePoint(0));
  });
});

/** A CadView LoadState as its load effect reports it. */
const ls = (phase: LoadState["phase"], total: number, done: number): LoadState => ({ phase, total, done, failed: 0, bytes: 0, swapped: 0, kept: 0, started: 0, ms: 0 });

/** One load as CadView reports it: begin, the bodies arriving, ready, then the first frame. */
function runLoad(t: ReturnType<typeof attachLoadTracker>, files: number, model?: string) {
  const seen: boolean[] = [];
  const watch = () => seen.push(t.tracker.snapshot().visible);
  t.loadState(ls("loading", files, 0), model);
  watch();
  for (let i = 1; i <= files; i++) {
    t.loadState(ls("loading", files, i), model);
    watch();
  }
  t.loadState(ls("ready", files, files), model);
  watch();
  t.frame();
  watch();
  return seen;
}

describe("the loading screen's lifecycle (R1-B, B1: no screen on a rebuild)", () => {
  it("shows on the first load of a model, not on a rebuild of it, and again when the model changes", () => {
    const t = attachLoadTracker(new LoadTracker(clock().now));
    try {
      // first load: the screen until the first frame
      expect(runLoad(t, 3, "clientx|")).toEqual([true, true, true, true, true, false]);
      expect(t.tracker.snapshot()).toMatchObject({ stage: "ready", visible: false, mode: "load", title: "Loading model" });
      // the dev server rebuilt: the same model is swapped in place, the screen never mounts
      const updates = runLoad(t, 3, "clientx|");
      expect(updates.every((v) => v === false)).toBe(true);
      // while it ran, the snapshot said "Updating model" and that an update was under way
      t.loadState(ls("loading", 2, 0), "clientx|");
      expect(t.tracker.snapshot()).toMatchObject({ mode: "update", title: "Updating model", visible: false, updating: true });
      t.loadState(ls("ready", 2, 2), "clientx|");
      t.frame();
      expect(t.tracker.snapshot()).toMatchObject({ visible: false, updating: false });
      // another model (a level, a different system): a load again
      expect(runLoad(t, 2, "clientx|pcb")[0]).toBe(true);
      // and back to a model already shown before the last one: a load (the one on screen changed)
      expect(runLoad(t, 2, "clientx|")[0]).toBe(true);
    } finally {
      t.detach();
    }
  });

  it("treats every load after the first as an update when the view names no model (until CadView passes it)", () => {
    const t = attachLoadTracker(new LoadTracker(clock().now));
    try {
      expect(runLoad(t, 1)[0]).toBe(true);
      expect(runLoad(t, 1).some(Boolean)).toBe(false);
      expect(runLoad(t, 4).some(Boolean)).toBe(false);
    } finally {
      t.detach();
    }
  });

  it("keeps the first load's screen when a rebuild lands before the first frame", () => {
    const t = attachLoadTracker(new LoadTracker(clock().now));
    try {
      t.loadState(ls("loading", 3, 0), "m");
      t.loadState(ls("loading", 3, 1), "m");
      // the effect restarts for a new bundle mid-load: still loading, still the screen (no second begin)
      t.loadState(ls("loading", 3, 0), "m");
      expect(t.tracker.snapshot()).toMatchObject({ visible: true, mode: "load" });
    } finally {
      t.detach();
    }
  });

  it("decides the mode from what was shown", () => {
    expect(loadMode(false, undefined, "a")).toBe("load");
    expect(loadMode(true, "a", "a")).toBe("update");
    expect(loadMode(true, "a", "b")).toBe("load");
    expect(loadMode(true, undefined, undefined)).toBe("update");
  });

  it("numbers the loads, so an Escape release lasts one load", () => {
    const tr = new LoadTracker(clock().now);
    tr.push({ type: "begin", files: 1 });
    const a = tr.snapshot().loadId;
    tr.push({ type: "begin", files: 1, mode: "update" });
    expect(tr.snapshot().loadId).toBe(a + 1);
  });
});

describe("the loading screen's look (R1-B, B3 and B4)", () => {
  const loading = () => {
    const c = clock();
    const tr = new LoadTracker(c.now);
    tr.push({ type: "begin", files: 4 });
    c.advance(1500);
    tr.push({ type: "file", url: "a", bytes: 1 });
    return tr.snapshot();
  };

  it("draws the Protoboard mark in its triangle, the title, the stage and the bar", () => {
    const html = renderToStaticMarkup(createElement(LoadingScreen, { state: loading() }));
    expect(html).toContain(MARK_PATH.slice(0, 40));
    expect(html).toContain("cad-loading-mark");
    expect(html).toContain("cad-loading-dot head");
    expect(html).toContain(">Loading model<");
    expect(html).toContain("Fetching parts (1 of 4");
    expect(html).toContain("cad-loading-bar");
    expect(html).not.toMatch(/\.glb|\.step|\.json/);
  });

  it("lays a translucent scrim in the theme's scene colour, never a literal light fallback", () => {
    const html = renderToStaticMarkup(createElement(LoadingScreen, { state: loading() }));
    expect(html).toContain(`color-mix(in srgb,var(--uhd-scene-background,var(--uhd-background,#131313)) ${Math.round(SCRIM_OPACITY * 100)}%,transparent)`);
    expect(SCRIM_OPACITY).toBeGreaterThan(0.3);
    expect(SCRIM_OPACITY).toBeLessThan(0.75);
    // the old names were not theme tokens and fell back to white
    expect(html).not.toContain("--uhd-bg");
    expect(html).not.toContain("--uhd-line");
    expect(html).not.toMatch(/#fff/);
    expect(html).toContain("var(--uhd-overlay");
  });

  it("soft-locks input while it shows (Escape releases it) and says how", () => {
    const html = renderToStaticMarkup(createElement(LoadingScreen, { state: loading() }));
    expect(html).toContain("data-locked");
    expect(html).toContain('data-mode="load"');
    expect(html).toContain("pointer-events:auto");
    expect(html).toContain("Esc to look around while it loads");
    expect(html).toContain(".cad-loading-screen.released{background:transparent;pointer-events:none");
  });

  it("renders nothing for an update of the model on screen", () => {
    const tr = new LoadTracker(clock().now);
    tr.push({ type: "begin", files: 2, mode: "update" });
    expect(tr.snapshot()).toMatchObject({ visible: false, updating: true, title: "Updating model" });
    expect(renderToStaticMarkup(createElement(LoadingScreen, { state: tr.snapshot() }))).toBe("");
  });
});
