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

/**
 * The 3D toolbar's Explode and Assemble glyphs (R2-B, 2026-11-02, Kevin's walkthrough H2: "a custom icon for explode,
 * that one goes all at once, boom; for assemble, the sequential step"). Same family: the small cube of the view
 * glyphs, Lucide's 24-unit box and 1.75 stroke.
 *
 * - Explode: the cube's three faces pushed out from its middle, each along its own normal, with a burst of short
 *   rays between them (all at once, outward).
 * - Assemble: three plates stacked one above another, the top one coming down onto the others (step by step).
 */
export function ExplodeGlyph({ size = 16, ...rest }: { size?: number } & Omit<SVGProps<SVGSVGElement>, "width" | "height">) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden data-glyph="explode" {...rest}>
      {/* the top face lifted, the front and side faces pushed out down-left and down-right */}
      <path d="M12 1.5 18 4.8 12 8.1 6 4.8Z" fill="currentColor" fillOpacity={0.55} />
      <path d="M2.6 9.6 8.6 12.9v6.6l-6-3.3Z" fill="currentColor" fillOpacity={0.3} />
      <path d="M21.4 9.6 15.4 12.9v6.6l6-3.3Z" fill="currentColor" fillOpacity={0.12} />
      {/* the burst at the middle */}
      <path d="M12 11.2v1.6M12 15.4v1.8M10.1 13.9l-1.2.7M13.9 13.9l1.2.7" />
    </svg>
  );
}

export function AssembleGlyph({ size = 16, ...rest }: { size?: number } & Omit<SVGProps<SVGSVGElement>, "width" | "height">) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden data-glyph="assemble" {...rest}>
      {/* two plates in place, the third coming down onto them along the arrow */}
      <path d="M4 17.5 12 21.5 20 17.5 12 13.5Z" fill="currentColor" fillOpacity={0.3} />
      <path d="M4 13.5 12 17.5 20 13.5" />
      <path d="M4 7 12 11 20 7 12 3Z" fill="currentColor" fillOpacity={0.55} />
      <path d="M12 11.6v2.2" />
    </svg>
  );
}
