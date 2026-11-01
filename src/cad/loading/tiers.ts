/**
 * The loading screen's lighter tiers, wired to the loads (PB-1177 with PB-1176's tiers; the wave 2 gate's item):
 *
 * - before any GLB is fetched, a pre-flight over the view sidecars (`X.view.json`, small, size-capped) sums one
 *   frame of the model; over the limits the tracker enters "preflight" and the screen offers "Load coarse",
 *   "Show boxes" or "Load it all" (it never refuses);
 * - the choice (`choose`, which CadView passes to the screen as `onLoadTier`) sets the tier every body loads at:
 *   `loadModel(url, { tier: "coarse" })` for coarse, `loadBoxes(url)` for boxes (one box per sidecar node), the
 *   ordinary load for fine; a choice made while loading (the screen offers it after 10 s) reloads at that tier.
 *
 * `useLoadTiers` is the hook CadView mounts (handoffs.md, 2026-11-01 W3-C to W3-B, the exact lines).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { loadBoxes, loadModel, type LoadedModel } from "../scene";
import { preflightFromSidecars } from "./preflight";
import type { LoadTier, LoadTracker, Preflight } from "./stages";

/** A body at a tier: the model (coarse or fine), or its boxes dressed as a model (`gltf.scene` is the boxes group, in the GLB's frame). */
export async function loadAtTier(url: string, tier: LoadTier): Promise<LoadedModel | null> {
  if (tier === "coarse") return loadModel(url, { tier: "coarse" });
  if (tier === "boxes") {
    const boxes = await loadBoxes(url);
    // no sidecar: no boxes to show; the model itself (a body without an index is light: W1-A writes one for every body)
    if (!boxes) return loadModel(url);
    return { gltf: { scene: boxes } as unknown as GLTF, hash: `boxes:${url}`, url, path: url, source: "sidecar", bytes: 0, parseMs: 0 } as LoadedModel;
  }
  return loadModel(url);
}

/** GLB URLs (one per drawn body, undefined for a body with none) as URL → placements, for the pre-flight. */
export function glbPlacements(urls: readonly (string | undefined)[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const u of urls) if (u) out.set(u, (out.get(u) ?? 0) + 1);
  return out;
}

/** The tier gate one view keeps: the pre-flight, the wait for a choice when heavy, and the choice. */
export class TierGate {
  tier: LoadTier = "fine";
  preflight: Preflight | undefined;
  private chosen = false;
  private waiting: ((t: LoadTier) => void) | undefined;
  private subs = new Set<(t: LoadTier) => void>();

  constructor(private tracker?: () => LoadTracker | undefined) {}

  /**
   * Pre-flight over the sidecars of `glbs` (URL → placements). Resolves with the tier to load at: at once when
   * light (or when a tier was chosen already), else when a person or agent chooses.
   */
  async plan(glbs: ReadonlyMap<string, number>, fetcher?: typeof fetch): Promise<LoadTier> {
    if (this.chosen) return this.tier;
    const p = await preflightFromSidecars(glbs, fetcher);
    this.preflight = p;
    this.tracker?.()?.push({ type: "preflight", preflight: p });
    if (!p.over || this.chosen) return this.tier;
    return new Promise<LoadTier>((resolve) => (this.waiting = resolve));
  }

  /** The choice (the loading screen's `onLoadTier`, an agent): every body loads at this tier from now on. */
  choose(tier: LoadTier): void {
    const changed = tier !== this.tier;
    this.tier = tier;
    this.chosen = true;
    this.tracker?.()?.push({ type: "choose", tier });
    const w = this.waiting;
    this.waiting = undefined;
    w?.(tier);
    if (changed) for (const cb of this.subs) cb(tier);
  }

  onChange(cb: (t: LoadTier) => void): () => void {
    this.subs.add(cb);
    return () => void this.subs.delete(cb);
  }

  /** A body's model at the current tier. */
  load(url: string): Promise<LoadedModel | null> {
    return loadAtTier(url, this.tier);
  }
}

export interface LoadTiers {
  /** The tier the bodies load at now. */
  tier: LoadTier;
  /** False while a heavy model waits for a choice (the body loads wait too). */
  ready: boolean;
  /** Pass to the loading screen as `onLoadTier` (CadView's prop of that name, then `LoadingScreen onChoose`). */
  choose: (tier: LoadTier) => void;
  /** A body's model at the current tier (in place of `loadModel(url)` in CadView's body loads). */
  load: (url: string) => Promise<LoadedModel | null>;
  gate: TierGate;
}

/**
 * The hook CadView mounts: runs the pre-flight when `key` changes (a new model), holds the choice, and re-renders
 * when the tier changes so the body loads run again at it. `glbs` lists the bodies' GLB URLs with their placements.
 */
export function useLoadTiers(key: unknown, glbs: () => ReadonlyMap<string, number> | undefined, tracker?: () => LoadTracker | undefined): LoadTiers {
  const gate = useRef<TierGate>(null as unknown as TierGate);
  if (!gate.current) gate.current = new TierGate(tracker);
  const [tier, setTier] = useState<LoadTier>(gate.current.tier);
  // ready for this key only: a new model is not ready in the very render that brings it (no load starts early)
  const [planned, setPlanned] = useState<{ key: unknown } | null>(null);
  useEffect(() => gate.current.onChange(setTier), []);
  useEffect(() => {
    const list = glbs();
    if (!list || !list.size) {
      setPlanned({ key });
      return;
    }
    let off = false;
    void gate.current.plan(list).then((t) => {
      if (off) return;
      setTier(t);
      setPlanned({ key });
    });
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const choose = useCallback((t: LoadTier) => gate.current.choose(t), []);
  const load = useCallback((url: string) => gate.current.load(url), []);
  return { tier, ready: planned !== null && planned.key === key, choose, load, gate: gate.current };
}
