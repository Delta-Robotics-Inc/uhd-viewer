# 3D view style guide

Status: first build, 2026-11-01 (PB-1189, phase 1 wave 3). Decisions marked DEFAULT were taken overnight without the
owner and are open for review. Written fresh for this repository from the review notes on the anatomy baseline and
the earlier Blender cel-shade guide ("Hazard"); no text or recipe is carried over from either.

## What the look is

The 3D view draws hardware the way a good textbook figure does: a pale or near-black ground, bodies in a few close
matte tones, thin even ink around every part, and colour only where it means something. Two goals sit underneath:

1. **Depth reads at a glance.** Three flat bands of light on every surface tell the eye which way each face turns,
   without gloss, reflections or soft gradients. This is the part of the cel-shade guide that stays: the bands
   help the brain build the shape.
2. **The picture is calm enough to annotate.** Callouts, DRC markers and selection sit on top of the model and
   must win. So the model itself is quiet: no texture, no noise, no strong colour of its own unless the part has
   one (a green board, an orange prop).

It runs live, on demand, on an integrated GPU, so every rule below is something a shader can do in one pass.

## Two token sets

Every colour is a theme token (`src/theme/tokens.ts`); the 3D scene reads them from the themed element it sits in.
The viewer's light theme carries the **anatomy paper** set and its dark theme the **anatomy dark** set
(`PAPER_SCENE_TOKENS` and `DARK_SCENE_TOKENS` in `src/theme/themes.ts`). A VS Code host gets the set of its theme
kind (light and high-contrast light take paper; dark and high-contrast take dark).

Which one shows:

- in VS Code: the editor's theme kind, following it as it changes;
- on the web: the system's `prefers-color-scheme` (DEFAULT: a page with no theme option follows the system; it
  used to be always dark);
- an explicit override wins over both: `?theme=light|dark|system` in the URL today (`paper` is an alias of
  `light`); a `theme` field in the view state once W3-A adds it (the URL becomes its URL form).

### Token roles

| Role | Tokens | Rule |
|---|---|---|
| Ground | `sceneBackground`, `sceneGrid`, `sceneGridMinor` | One value per theme. Paper is near white, dark is near black (never pure black). The grid is faint and writes no depth, so it never gets ink. |
| Body tones | `modelToneLit`, `modelToneMid`, `modelToneShade` | The three bands a part with no colour of its own shows. A coloured part keeps its hue and is scaled by each band's luminance over the lit band's. Close together: the lit band is never 3:1 over the shaded one. |
| Ink | `inkSilhouette`, `inkCrease`, `inkFaint`, `inkWidth` | Silhouettes and depth steps in the strong ink, folds inside a part in the crease ink, one width on screen at any zoom. |
| Selection | `accent` | The one accent: selection blue (DEFAULT), the UI's existing blue. A selected part glows in it. Nothing else on the model uses it. |
| Findings | `drcError`, `drcWarning`, `drcInfo`, `drcRisk`, `drcPass`, `drcUnknown` | Red, yellow, blue, orange, green, grey. Each one is at least 4.5:1 against its theme's ground and against a callout card (the test computes it). Colour is never the only signal: each severity has its own marker shape (red octagon, yellow triangle, orange diamond, green circle with a check, grey dashed circle). Orange belongs to "risk" alone. |
| Callouts | `calloutSurface`, `calloutBorder`, `calloutText`, `calloutLabel`, `calloutLeader`, `calloutLeaderWidth`, `calloutDot`, `calloutGhost` | The card, its outline, its sentence text, the mono uppercase id on the shelf, the leader line and its width, the terminal dot on the part, and the ghosted form of a marker whose anchor is hidden behind a part. |
| Sections | `sectionCap`, `sectionLine` | The flat fill where a plane cuts through solid material, and the exact cut outline drawn on it once the view is still. |

The brand colour is not a token of the 3D view. It belongs to the host's chrome and to exported stills, never to
the model.

## Shading

- One key light fixed to the camera (above and to the left), so the bands stay meaningful as the model turns. The
  cosine between a face's normal and the key picks the band; there is no specular term, no environment light and
  no tone mapping, so the tones on screen are exactly the tokens.
- A highlight (selection, an agent's focus) is added on top of the band, so selecting still works on instanced
  parts without touching their materials.
- See-through parts (props, x-ray shells) keep their opacity and get no ink of their own.

## Ink

- One screen-space pass over the depth buffer. Where the reciprocal of depth bends across a pixel there is a fold
  or a step. Flat faces never ink, at any angle, because that quantity is linear across a plane on screen.
- A large outward bend (a part's outline against what lies behind it) takes the silhouette ink; a small bend (an
  edge between two faces of one part) takes the crease ink. Curved surfaces stay clean.
- Width is constant in CSS pixels. No taper, no width variation, no hand-drawn wobble.
- The ink is an effect the quality curve may switch off while the view moves over its frame budget, and it comes
  back when the view settles.

## Sections

- Up to three planes, each an axis of the assembly, a position along it and the side it keeps. With no side set,
  the plane keeps the half away from the camera, so the cut faces the viewer.
- A plane cuts the whole model or one subtree (DEFAULT: one scope per view, shared by its planes).
- While moving, the caps are a stencil fill in `sectionCap`; once the view is still, the exact cut is computed on
  the CPU, drawn as an outline in `sectionLine`, and returned as data (polylines per part, in mm) by `observe()`.
- Sections and tours agree by default: a tour step that sets planes uses the same planes a person would.

## Callouts, DRC markers and exploded-view labels

Revised in fix wave R1 (R1-C, 2026-11-01) from Kevin's walkthrough (items D1 to D5, M10, M12). Values marked
DEFAULT are in code comments and can be revisited.

- **The card.** Rounded with the app's `radius` (8 px), not chamfered; a fill one step off the ground
  (`calloutSurface`: `#242424` on the `#131313` void, `#efefec` on the `#fbfbfa` paper) and a 1 px outline
  (`calloutBorder`, or the finding's severity colour on a DRC card). The DRC set stays at least 4.5:1 on the card
  (the test computes it). The card wraps at 320 px (DEFAULT) and never clips mid-token: instance paths break at
  `/`, `.` and `_`; a value or sentence ends in an ellipsis after four lines (DEFAULT).
- **The leader.** Option A as before (Kevin liked it): horizontal, vertical or 45-degree legs, the window-aware
  side flip, a shelf under the card that tucks under its rounded corner. 1.75 px in both themes (DEFAULT, was 1.25
  and 1), in the card's tone.
- **The DRC marker.** Attached to the part, not over its bounds: a terminal dot on the part's surface nearest the
  top centre of its bounds (found on its meshes, straight down first, then along the camera's ray), a 12 px stem up
  the screen (DEFAULT), the severity marker on top. All three are depth-tested; the ghost copy shows a hidden
  marker. The marker grows with the part on screen, never under 16 px and never over 26 px (DEFAULT).
- **Hover tiers.** A short hover (the 80 ms intent delay) shows the title; a hover held 600 ms (DEFAULT) adds a
  one-line description (the message's first clause, parentheticals dropped, at most 120 characters); a click pins
  the card with the raw rows (AT path, BY validator, MORE n) and the full message and asks the host to open the
  finding in the Inspector. Keyboard focus shows both tiers at once.
- **The wheel.** Over a card, pin, marker or exploded-view label the wheel zooms the view (the event is forwarded
  to the canvas); hover and click stay on the label.
- **Exploded-view labels.** The coloured end bar is on the side the leader enters. A label keeps its column until
  its anchor has been past the midline by more than 8 % of the view's width for 150 ms (DEFAULT); a slot change
  eases over 120 ms, ease-out (DEFAULT), while ordinary motion follows the anchor in the same frame; labels are
  clamped to the view and never push a neighbour off it. Labels whose anchor is behind the model's centre are drawn
  at 60 % (DEFAULT). A subtitle is the part's refdes or MPN, or nothing; how the viewer placed a part ("placed by a
  display hint") is never shown.

## What is deliberately not done

- **No grain, no scanlines, no film noise at runtime.** They flicker under live animation and fight annotations.
  If they ever return, it is only on exported stills that ask for them.
- **No heavy vignette, no bloom, no depth of field, no glossy reflections.** The look is matte.
- **No square leader elbows and no free-angle leaders.** Leaders are horizontal, vertical or 45-degree legs joined
  by a 45-degree chamfer, ending in a horizontal shelf under the label (DEFAULT, option A of the round-2 review);
  at most one bend before the shelf; no arrowheads; a small dot on the part.
- **No orange accent.** Orange means risk.
- **No colour without a meaning.** A part shows a colour only when it has one (a display hint or a declared
  material); otherwise it takes the theme's body tones.
- **No hard, high-contrast "industrial" bands.** The tones stay close together; depth comes from three steps and
  the ink, not from drama.

## Where it lives

| Piece | File |
|---|---|
| Tokens and the two sets | `src/theme/tokens.ts`, `src/theme/themes.ts` |
| Contrast maths | `src/theme/contrast.ts` (tests: `test/theme-tokens.test.ts`) |
| Theme choice (system, VS Code, URL) | `src/theme/resolve.ts`, `src/theme/adapters.ts` |
| Bands, twins, ink thresholds | `src/cad/render/toon.ts` |
| The ink pass and caps in the frame | `src/cad/scene.ts` |
| Sections | `src/cad/sections/` |
| Callouts and DRC markers (look, layout, wheel) | `src/cad/annot/style.ts`, `layer.ts`, `place.ts`, `leader.ts`, `wheel.ts` |
| Exploded-view labels | `src/cad/labels.ts` |

## Open for review

- The paper bands were spread wider than the round-2 proposal so they read at the viewer's size (DEFAULT).
- The dark bands are the round-2 proposal; coloured parts get dark in the shaded band.
- The ink thresholds were tuned on the drone and ClientX at 1440x900; other scales may want other values.
- Whether the web app should follow the system by default or stay dark until a person chooses.
