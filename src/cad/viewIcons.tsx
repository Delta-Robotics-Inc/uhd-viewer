/**
 * The standard-view glyphs of the model toolbars (ModelView, GcodeView; R1-D, Kevin's walkthrough E2: "top view
 * and isometric view are kind of terrible icons": Top was a down arrow, Isometric a plain cube).
 *
 * One family, drawn as Lucide draws (24-unit box, `currentColor` stroke at the toolbar's 1.75, round joins), so they
 * sit with the rest of the bar: the same small cube seen from the usual corner, with the face the view looks at
 * filled, as a CAD view cube shows it. Isometric fills all three faces in three tones (lit top, mid front, dark
 * side), so it reads as the 3D view itself.
 */
import type { SVGProps } from "react";

export type ViewFace = "iso" | "top" | "front" | "right";

// the cube's corners (an isometric hexagon) and its three visible faces
const TOP = "M12 3 20 7.5 12 12 4 7.5Z";
const FRONT = "M4 7.5 12 12v9l-8-4.5Z";
const RIGHT = "M12 12 20 7.5v9L12 21Z";
const OUTLINE = "M12 3 20 7.5v9L12 21l-8-4.5v-9Z";
const EDGES = "M4 7.5 12 12 20 7.5M12 12v9";

/** Fill opacity of each face per view (DEFAULT tones: the toon look's lit, mid and shade read as 0.55, 0.3, 0.12). */
const FILLS: Record<ViewFace, { top: number; front: number; right: number }> = {
  iso: { top: 0.55, front: 0.3, right: 0.12 },
  top: { top: 0.75, front: 0, right: 0 },
  front: { top: 0, front: 0.75, right: 0 },
  right: { top: 0, front: 0, right: 0.75 },
};

export function ViewGlyph({ face, size = 16, ...rest }: { face: ViewFace; size?: number } & Omit<SVGProps<SVGSVGElement>, "width" | "height">) {
  const f = FILLS[face];
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      data-view-glyph={face}
      {...rest}
    >
      {f.top > 0 && <path d={TOP} fill="currentColor" fillOpacity={f.top} stroke="none" />}
      {f.front > 0 && <path d={FRONT} fill="currentColor" fillOpacity={f.front} stroke="none" />}
      {f.right > 0 && <path d={RIGHT} fill="currentColor" fillOpacity={f.right} stroke="none" />}
      <path d={OUTLINE} />
      <path d={EDGES} />
    </svg>
  );
}
