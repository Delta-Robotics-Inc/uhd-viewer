/**
 * Artifacts in the inspector: a module's or harness's thumbnail, and its body
 * CAD in a small viewer that turns slowly until grabbed, then orbits with the
 * pointer (drag to rotate, scroll to zoom, right-drag to pan). Other CAD and
 * drawing files are listed with a link to open them.
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { ArtifactDef, ModuleDef } from "@uhd/types/index.js";
import { glbFor } from "../cad/model";
import { cadWrapper, createScene, loadGlb, materialFor } from "../cad/scene";
import type { Appearance } from "../source/source";
import { Icon } from "../canvas/Icon";
import { isBoardDrawing } from "../model/outputs";
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
  if (!parts.length) return null;
  const cur = parts[Math.min(pick, parts.length - 1)];
  return (
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
  );
}

export function ArtifactsSection({ def, resolve, appearance, titled = true }: { def?: ModuleDef; resolve: ArtifactResolver; appearance?: Appearance; titled?: boolean }) {
  if (!def) return null;
  const thumb = thumbnailOf(def);
  const glb = glbFor(def);
  const files = (def.artifacts ?? []).filter((a) => a !== glb && a !== thumb && !isBoardDrawing(a) && (a.role === "body" || a.role === "drawing") && (a.filePath || a.url));
  if (!thumb && !glb && !files.length) return null;
  return (
    <>
      {titled && <div className="section-title">ARTIFACTS</div>}
      {thumb && <Thumbnail url={urlOf(def, thumb, resolve)} name={thumb.name} />}
      {glb && <CadPreview def={def} url={urlOf(def, glb, resolve)} appearance={appearance} />}
      {files.length > 0 && (
        <div className="artifact-files">
          {files.map((a) => {
            const url = urlOf(def, a, resolve);
            return (
              <ArtifactLink key={a.id} defId={def.id} artifactId={a.id} href={url} title={a.filePath ?? a.url}>
                <Icon name={a.role === "drawing" ? "file-text" : "box"} size={11} />
                <span className="artifact-name">{a.name}</span>
                <span className="artifact-format">{(a.format ?? a.type).toUpperCase()}</span>
              </ArtifactLink>
            );
          })}
        </div>
      )}
    </>
  );
}

function Thumbnail({ url, name }: { url?: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) return null;
  return (
    <div className="artifact-thumb">
      <img src={url} alt={name} onError={() => setFailed(true)} />
    </div>
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
