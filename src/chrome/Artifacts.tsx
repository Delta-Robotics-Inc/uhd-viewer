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

export type ArtifactResolver = (definitionId: string, filePath: string) => string | undefined;

const IMAGE = /\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i;

/**
 * The library's convention: an image artifact tagged "thumbnail"; failing that
 * any image (by MIME type or extension), a datasheet's pages last.
 */
export function thumbnailOf(def: ModuleDef): ArtifactDef | undefined {
  const images = (def.artifacts ?? []).filter((a) => a.mimeType?.startsWith("image/") || IMAGE.test(a.filePath ?? a.url ?? ""));
  return images.find((a) => a.tags?.includes("thumbnail")) ?? images.find((a) => a.type !== "datasheet") ?? images[0];
}

const urlOf = (def: ModuleDef, a: ArtifactDef, resolve: ArtifactResolver) => a.url ?? (a.filePath ? resolve(def.id, a.filePath) : undefined);

export function ArtifactsSection({ def, resolve, appearance }: { def?: ModuleDef; resolve: ArtifactResolver; appearance?: Appearance }) {
  if (!def) return null;
  const thumb = thumbnailOf(def);
  const glb = glbFor(def);
  const files = (def.artifacts ?? []).filter((a) => a !== glb && a !== thumb && (a.role === "body" || a.role === "drawing") && (a.filePath || a.url));
  if (!thumb && !glb && !files.length) return null;
  return (
    <>
      <div className="section-title">ARTIFACTS</div>
      {thumb && <Thumbnail url={urlOf(def, thumb, resolve)} name={thumb.name} />}
      {glb && <CadPreview def={def} url={urlOf(def, glb, resolve)} appearance={appearance} />}
      {files.length > 0 && (
        <div className="artifact-files">
          {files.map((a) => {
            const url = urlOf(def, a, resolve);
            return (
              <a key={a.id} className="artifact-file" href={url} target="_blank" rel="noreferrer" title={a.filePath ?? a.url}>
                <Icon name={a.role === "drawing" ? "file-text" : "box"} size={11} />
                <span className="artifact-name">{a.name}</span>
                <span className="artifact-format">{(a.format ?? a.type).toUpperCase()}</span>
              </a>
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
      const vendor = /vendor/.test(url);
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
