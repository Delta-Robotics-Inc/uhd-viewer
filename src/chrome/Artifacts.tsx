/**
 * Artifacts in the inspector: a module's or harness's picture, its body CAD
 * in a small viewer that turns slowly until grabbed, then orbits with the
 * pointer (drag to rotate, scroll to zoom, right-drag to pan), and every
 * artifact as a card (ArtifactCards.tsx): images, models, board drawings,
 * datasheets, documents, design files and data.
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { ArtifactDef, ModuleDef } from "@uhd/types/index.js";
import { glbFor } from "../cad/model";
import { cadWrapper, createScene, loadGlb, materialFor } from "../cad/scene";
import type { Appearance } from "../source/source";
import { circuitOutputs, isBoardDrawing } from "../model/outputs";
import { artifactCards, isInternalArtifact } from "../model/artifacts";
import { ArtifactCards } from "./ArtifactCards";
import { useHost } from "../host/context";

import type { ArtifactResolver } from "../api";
export type { ArtifactResolver };

const IMAGE = /\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i;

/**
 * The library's convention: an image artifact tagged "thumbnail"; failing that
 * any image (by MIME type or extension), a datasheet's pages last.
 */
export function thumbnailOf(def: ModuleDef): ArtifactDef | undefined {
  // a board's PCB and schematic drawings are views of the design (shown with the board), not pictures of it
  const images = (def.artifacts ?? []).filter((a) => !isBoardDrawing(a) && (a.mimeType?.startsWith("image/") || IMAGE.test(a.filePath ?? a.url ?? "")));
  return images.find((a) => a.tags?.includes("thumbnail")) ?? images.find((a) => a.type !== "datasheet") ?? images[0];
}

/**
 * An artifact file row: a link to the file, or, when a host takes artifacts
 * (`onOpenArtifact`), a request to the host to open it.
 */
export function ArtifactLink({ defId, artifactId, href, title, children }: { defId: string; artifactId: string; href?: string; title?: string; children: React.ReactNode }) {
  const { openArtifact } = useHost();
  return (
    <a
      className="artifact-file"
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      data-artifact={artifactId}
      onClick={
        openArtifact &&
        ((e) => {
          e.preventDefault();
          openArtifact(defId, artifactId);
        })
      }
    >
      {children}
    </a>
  );
}

const urlOf = (def: ModuleDef, a: ArtifactDef, resolve: ArtifactResolver) => a.url ?? (a.filePath ? resolve(def.id, a.filePath) : undefined);

const hasArtifacts = (def: ModuleDef) => Boolean(thumbnailOf(def) || glbFor(def));

/**
 * An assembly (FC + ESC stack, an arm) usually has no CAD of its own: show its
 * parts' artifacts instead, one part at a time, picked from a row of names.
 */
export function AssemblyArtifacts({
  def,
  lookup,
  resolve,
  appearance,
}: {
  def?: ModuleDef;
  lookup: (id?: string) => ModuleDef | undefined;
  resolve: ArtifactResolver;
  appearance?: Record<string, Appearance>;
}) {
  const [pick, setPick] = useState(0);
  if (!def) return null;
  if (hasArtifacts(def)) return <ArtifactsSection def={def} resolve={resolve} appearance={appearance?.[def.id]} />;
  // parts with artifacts, depth first, once per definition
  const parts: { name: string; def: ModuleDef }[] = [];
  const seen = new Set<string>();
  const walk = (d: ModuleDef, depth: number) => {
    for (const ref of d.children ?? []) {
      const c = lookup(ref.moduleDefId);
      if (!c || seen.has(c.id)) continue;
      seen.add(c.id);
      if (hasArtifacts(c)) parts.push({ name: ref.name ?? c.name, def: c });
      else if (depth < 3) walk(c, depth + 1);
    }
  };
  walk(def, 0);
  const cur = parts[Math.min(pick, parts.length - 1)];
  return (
    <>
      {/* the module's own artifacts (documents, sources) come first; its parts' follow */}
      <ArtifactsSection def={def} resolve={resolve} appearance={appearance?.[def.id]} />
      {cur && (
        <>
          <div className="section-title">ARTIFACTS · PARTS</div>
          <div className="artifact-parts">
            {parts.map((p, i) => (
              <button key={p.def.id} className={`mini${p === cur ? " on" : ""}`} onClick={() => setPick(i)}>
                {p.name.toUpperCase()}
              </button>
            ))}
          </div>
          <ArtifactsSection def={cur.def} resolve={resolve} appearance={appearance?.[cur.def.id]} titled={false} />
        </>
      )}
    </>
  );
}

/**
 * A definition's artifacts: its picture, its body model (turning in a small
 * 3D preview, unless the host shows models as cards), and every artifact as
 * a card under its kind. A board's drawings and outputs are left to the
 * board's own section (BoardViews).
 */
export function ArtifactsSection({ def, resolve, appearance, titled = true }: { def?: ModuleDef; resolve: ArtifactResolver; appearance?: Appearance; titled?: boolean }) {
  const host = useHost();
  if (!def) return null;
  const live = host.artifactModels !== "cards";
  const picture = thumbnailOf(def);
  // the picture is shown large only when it may be loaded; one at a web address a host does not load stays a card (its icon and host)
  const thumb = picture && !(host.remoteImages === false && !picture.filePath) && urlOf(def, picture, resolve) ? picture : undefined;
  const glb = live ? glbFor(def) : undefined;
  // a board's drawings and outputs are its own section's cards (BoardViews)
  const outs = circuitOutputs(def);
  const board = new Set(outs ? Object.values(outs).filter(Boolean) : []);
  const files = host.evidence?.(def.id);
  const cards = artifactCards(def, resolve, {
    // shown above: the picture and the turning model
    skip: (a) => a === thumb || a === glb || board.has(a),
    previewFor: host.artifactPreview,
    remoteImages: host.remoteImages,
    sources: files?.sources,
  });
  if (!thumb && !glb && !cards.length) return null;
  return (
    <>
      {titled && <div className="section-title">ARTIFACTS · {(def.artifacts ?? []).filter((a) => (a.filePath || a.url) && !board.has(a) && !isInternalArtifact(a)).length}</div>}
      {thumb && <Thumbnail defId={def.id} artifactId={thumb.id} url={urlOf(def, thumb, resolve)} name={thumb.name} remote={!thumb.filePath} />}
      {glb && <CadPreview def={def} url={urlOf(def, glb, resolve)} appearance={appearance} />}
      <ArtifactCards cards={cards} />
    </>
  );
}

/** The part's picture, large: the first card of its artifacts. A click opens it. */
function Thumbnail({ defId, artifactId, url, name, remote }: { defId: string; artifactId: string; url?: string; name: string; remote: boolean }) {
  const { openArtifact, remoteImages } = useHost();
  const [failed, setFailed] = useState(false);
  if (!url || failed || (remote && remoteImages === false)) return null;
  return (
    <a
      className="artifact-thumb"
      href={openArtifact ? undefined : url}
      target="_blank"
      rel="noreferrer"
      role={openArtifact ? "button" : undefined}
      tabIndex={0}
      title={name}
      data-artifact={artifactId}
      onClick={
        openArtifact &&
        ((e) => {
          e.preventDefault();
          openArtifact(defId, artifactId);
        })
      }
      onKeyDown={
        openArtifact &&
        ((e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openArtifact(defId, artifactId);
          }
        })
      }
    >
      <img src={url} alt={name} loading="lazy" decoding="async" onError={() => setFailed(true)} />
    </a>
  );
}

function CadPreview({ def, url, appearance }: { def: ModuleDef; url?: string; appearance?: Appearance }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  useEffect(() => {
    if (!host.current || !url) return;
    setState("loading");
    const h = createScene(host.current);
    // a product shot, not a workspace: no floor grid
    h.scene.traverse((o) => {
      if (o instanceof THREE.GridHelper) o.visible = false;
    });
    h.controls.autoRotate = true;
    h.controls.autoRotateSpeed = 1.6;
    const stop = () => (h.controls.autoRotate = false);
    h.controls.addEventListener("start", stop);
    let cancelled = false;
    loadGlb(url).then((gltf) => {
      if (cancelled) return;
      if (!gltf) return setState("missing");
      const scene = gltf.scene.clone(true);
      // like the 3D view: vendor models, and outputs with colours of their own (a board), keep them
      const vendor = /vendor/.test(url) || ((gltf.parser.json.materials?.length ?? 0) > 0 && !appearance);
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        // like the 3D view: our own models take the part's appearance, vendor models keep theirs
        mesh.material = vendor ? (mesh.material as THREE.Material).clone() : materialFor(def, mesh.parent?.name ?? "", appearance);
      });
      h.root.add(cadWrapper(scene));
      h.root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(h.root);
      h.frameAll(box);
      // a little closer than framing the bounding sphere: the preview is small
      h.camera.position.lerp(h.controls.target, 0.25);
      setState("ready");
    });
    return () => {
      cancelled = true;
      h.controls.removeEventListener("start", stop);
      h.dispose();
    };
  }, [def, url, appearance]);
  if (!url) return null;
  return (
    <div className="artifact-cad">
      <div ref={host} className="artifact-cad-canvas" />
      <div className="artifact-cad-hint">{state === "loading" ? "LOADING MODEL…" : state === "missing" ? "MODEL NOT FOUND" : "DRAG TO ROTATE · SCROLL TO ZOOM"}</div>
    </div>
  );
}
