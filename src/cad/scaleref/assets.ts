/**
 * The banana's and the Benchy's meshes (R4-B, 2026-11-02).
 *
 * Both ship inside the viewer's own bundle (base64 in ./assets/bananaGlb.ts and ./assets/benchyGlb.ts, as source), so
 * every host (the VS Code tab, `protoboard dev`, the standalone app, the library) has them in every project without a
 * file to copy or serve. DEFAULT (R4-B): not separate files fetched by URL, because the library builds inline assets
 * and the VS Code extension copies only `protoboard-viewer.js` and `.css` into its webview folder (a URL or a lazy chunk
 * would 404 there); not Vite's `?inline` either (rolldown cannot load `.glb?inline` on Windows, os error 123). They
 * are decoded and parsed only when first shown (the Benchy only when chosen): until then each is a string literal.
 *
 * - the banana (`banana-for-scale.glb` before base64): Kevin's own scan (Delta Robotics, own scan; `Banana_Scan_2.stl`, 51,930 triangles),
 *   decimated in Blender 5.2 (collapse) to 10,000 triangles (DEFAULT R4-B, about 120 kB), its chord turned onto x,
 *   182 x 85 x 42 mm at true size.
 * - the Benchy (`3dbenchy.glb` before base64): #3DBenchy by Creative Tools (3DBenchy.com), CC0 1.0 Universal (public domain; the licence page
 *   allows modified versions and inclusion in software, so a converted copy is allowed), from `3dbenchy.stl` (225,706 triangles, 60 x 31 x 48 mm),
 *   decimated to 24,000 triangles (DEFAULT R4-B, about 290 kB).
 *
 * Both GLBs are glTF's convention, metres and Y up; they are turned back to scene mm and Z up here, at the boundary
 * (the same +90 degrees about x and x1000 as scene.ts's wrapper for model GLBs). Their local origin is the centre of
 * the footprint at the base.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { BANANA_GLB_BASE64 } from "./assets/bananaGlb";
import { BENCHY_GLB_BASE64 } from "./assets/benchyGlb";

export type MeshAsset = "banana" | "benchy";

/** DEFAULT (R4-B): the largest asset a data URL may decode to (security basics: a size cap on parsed files). */
export const MAX_ASSET_BYTES = 4 * 1024 * 1024;

/** Base64 to bytes (no fetch: a webview's CSP may not allow `data:` in connect-src). */
export function base64Bytes(b64: string): Uint8Array {
  if ((b64.length * 3) / 4 > MAX_ASSET_BYTES) throw new Error("asset too large");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** glTF (metres, Y up) to scene (mm, Z up): +90 degrees about x, then x1000. */
export const GLTF_TO_SCENE = new THREE.Matrix4().makeScale(1000, 1000, 1000).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));

const cache = new Map<MeshAsset, Promise<THREE.BufferGeometry>>();

/** The asset's geometry in scene mm, Z up, normals computed (shared; do not dispose). */
export function loadAsset(name: MeshAsset): Promise<THREE.BufferGeometry> {
  let p = cache.get(name);
  if (!p) {
    p = (async () => {
      const bytes = base64Bytes(name === "banana" ? BANANA_GLB_BASE64 : BENCHY_GLB_BASE64);
      const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, "");
      let geometry: THREE.BufferGeometry | undefined;
      gltf.scene.traverse((o) => {
        if (!geometry && (o as THREE.Mesh).isMesh) geometry = (o as THREE.Mesh).geometry;
      });
      if (!geometry) throw new Error(`${name}: no mesh in the asset`);
      const g = geometry.clone();
      // the units boundary: glTF metres Y-up to scene mm Z-up
      g.applyMatrix4(GLTF_TO_SCENE);
      g.deleteAttribute("normal");
      g.computeVertexNormals();
      g.computeBoundingBox();
      g.computeBoundingSphere();
      return g;
    })();
    p.catch(() => cache.delete(name));
    cache.set(name, p);
  }
  return p;
}
