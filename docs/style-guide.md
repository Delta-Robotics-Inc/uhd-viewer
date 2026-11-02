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
| Dimensions, angles, paths | `dimLine`, `dimExtension`, `dimChip`, `dimChipBorder`, `dimText`, `dimTierSurface`, `explodePath` | The dimension line and an angle's arc and ticks (as strong as the silhouette ink), the dashed extension lines (at least 3:1), the label chip, its outline and text, the tier tag inside it, and the explode path lines (low contrast on purpose: at least 1.8:1 on the ground, always fainter than the extension lines). An angle's NOW is the accent and a hard stop the fail red, as on a finding. The test computes every pair. |
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

Revised in fix wave R1 (R1-C, 2026-11-01) from Kevin's walkthrough (items D1 to D5, M10, M12), and in wave R2
(R2-C, 2026-11-02: plain-language text, crowded columns, instanced markers). Values marked DEFAULT are in code
comments and can be revisited.

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
  marker. The marker grows with the part on screen, never under 16 px and never over 26 px (DEFAULT). All dots and
  markers are one instanced draw (pictures from a small atlas), their ghosts a second, all stems a third, however
  many markers there are (R2-C; it was five draws a marker). A marker finds its part's surface once the view has
  settled, a few per frame (at most 6 ms of searching a frame, DEFAULT), and appears as it is found.
- **Hover tiers, in plain words.** A short hover (the 80 ms intent delay) shows the title; a hover held 900 ms
  (DEFAULT, Kevin 2026-11-02; the part tooltips use the same value) adds the one-line summary; a click pins the card
  with the title and summary, and the raw diagnostic (its message, and CODE, AT, BY, MORE rows) folded under a
  "Details" disclosure, and asks the host to open the finding in the Inspector. Keyboard focus shows both tiers at
  once. The title and summary are the stack's plain `title` and `summary` (R2-D) when a diagnostic carries them: the
  title is set in the sans face, sentence case; without them the title is the code in words (mono, uppercase) and
  the summary the message's first clause (parentheticals dropped, at most 120 characters). The marker's accessible
  name and the Findings list rows use the same title and summary.
- **The wheel.** Over a card, pin, marker or exploded-view label the wheel zooms the view (the event is forwarded
  to the canvas); hover and click stay on the label.
- **Exploded-view labels.** The coloured end bar is on the side the leader enters. A label keeps its column until
  its anchor has been past the midline by more than 8 % of the view's width for 150 ms (DEFAULT); a slot change
  eases over 120 ms, ease-out (DEFAULT), while ordinary motion follows the anchor in the same frame; labels are
  clamped to the view and never push a neighbour off it. Labels whose anchor is behind the model's centre are drawn
  at 60 % (DEFAULT). A subtitle is the part's refdes or MPN, or nothing; how the viewer placed a part ("placed by a
  display hint") is never shown. A long move eases longer: 120 ms plus 0.25 ms a pixel, at most 400 ms (DEFAULT).
- **Crowded columns.** Cards never overlap. A side whose full cards do not fit the view's height goes compact: one
  line, title only, 16 px tall, at most 160 px wide, 18 px apart (DEFAULT); it goes back to full cards only when they
  fit with 10 % to spare. Still too many: a second column one label width further out, or further in over the model
  when the first is against the view's edge, never over another column. Still too many: the least important labels
  (lowest severity, then farthest from the camera) collapse into a "+N" chip at the outer column's end, which lists
  them on hover. When both sides' columns would be clamped into the same strip (the model against an edge), the side
  with less room sends its labels across.
- **Out of the view.** A label whose anchor leaves the view (or goes behind the camera) is a small pin on the view's
  edge pointing toward it; a click on the pin does what a click on the card does.
- **Refdes and MPN labels.** A board's parts: the id in the label face, a muted end bar (an MPN's doubled); they are
  the labels that usually go compact.

### The card, after the concepts (R3-C, 2026-11-02)

Kevin, 2026-11-02: "I also like the dimensions, the callout style, the angles, and the dashed path lines coming from
the components." The leader stays option A. The card moves closer to concept A's risk card and concept B's agent pill:

- **Title row.** A finding: its severity glyph, the severity word in its colour and a dot ("RISK ·"), then the title
  in the card's label colour (it was all in the severity colour; the card's outline keeps the severity, walkthrough
  D4). A callout an agent, a host or a check wrote: a small inverted pill first ("AGENT" with the agent's star,
  "HOST", "CHECK"; the full "claude (agent)" is its tooltip) instead of the old "by ..." line; a person's own callout
  has no pill.
- **VALUE row and tier chips.** When a finding states a `value` ("3.1 mm ±0.2") and a `tier`, or a callout has VALUE
  and TIER rows, they show as `VALUE  3.1 mm ±0.2` (the number in mono) and one segmented strip NOMINAL | MESH |
  EXACT | MEASURED with the one that holds lit and bold (never colour alone).
- **Actions on the pinned card.** LOOK AT (accent, frame corners: frames the part), DETAILS (opens the raw diagnostic,
  which stays folded below), and P / N "Next" (the previous or next marker's card is pinned in its place). A pinned
  card with actions is at least 256 px wide (DEFAULT) so the row fits on one line.

## Dimensions and angles (R3-C, 2026-11-02)

After concept B (image 1). A dimension and an angle are records in the view state's `annotations` (kinds `dimension`
and `angle`, additive to `uhd-viewer.annotation/v0`), so they follow their parts, are saved with the callouts, undone,
and read and written by agents (`view_dimension`, `view_angle`: stack handoff).

- **A dimension.** Two small dots on the parts, dashed extension lines from them past a thin solid dimension line,
  two dots at the line's ends, and a chip on the line's middle pushed off it: `158.4 mm` and a tier tag `NOMINAL`.
  The line sits below the parts (away from the assembly's up) by 15 % of the distance, at least 6 mm (DEFAULT), unless
  the record gives an `offset`; the extension lines run 6 px past it (DEFAULT). The lines are in the scene and
  depth-tested, with a 22 % ghost where a part hides them (DEFAULT); the chip is on the page, so it stays upright and
  readable while the view orbits.
- **The number** is the distance as assembled, in mm (1 decimal from 10 mm up, 2 under it, DEFAULT), so taking the
  model apart never changes it; the drawing follows the parts. The tier says how it was taken: NOMINAL from the design
  frames (no picked points), MESH from points picked on the display mesh (the tolerance from the faces hit, shown as
  a `±`), EXACT from the B-rep (the CLI's geometry service), MEASURED from a bench.
- **Measure.** The ruler button in the 3D toolbar: click a point, then a second (a dot and a hint show the first);
  Escape drops a first pick, then ends the tool. A drag still orbits; the selection does not change. The record is
  the person's (`author: "user"`), MESH tier; the exact tier replaces the number when the host has the geometry
  service.
- **An angle.** About a revolute joint with its limits (the mates trait, the sequence's `joints`): a thin arc from 0°
  to the far stop at 1.25 times the arm, outside the part (never under 44 px on screen, DEFAULT), ticks at 0°, REST
  and each HARD STOP (red), the arm at the current angle in the accent (seen through the part as the ghost), and a
  dashed accent line on past the arc along it. Labels past the arc, each on a faint chip so it reads over a light
  part: `NOW 62°` (accent), `HARD STOP 95°` (red, with a small square), `REST 90°` and `0°` (muted). A label that
  lands on another moves a line down or up, else is left out. NOW is read from the part's pose on every frame, so it
  follows a drive, a motion clip and the Assemble play.

## Explode path lines (R3-C, 2026-11-02)

In an exploded view (Explode or Assemble), a thin dashed line from each moved part back to where it sits assembled
(concept B, the dashed lines under the arms and motors): `explodePath`, low contrast, depth-tested, drawn under the
callouts and dimensions; every line is one draw. None while assembled (explode under 0.2 %, DEFAULT) and none for a
move under 0.5 mm or 4 px (DEFAULT). A part inside a board draws only its own move relative to the board. Dashes are
5 px on, 4 px off at the lines' mean depth (DEFAULT).

## Assembly timeline

Built in wave R3 (R3-B, 2026-11-02) from Kevin's chosen concept (concept B, the panel at the bottom of its view): "the
assembly timeline is actually really nice. I think it should pop up underneath the toolbar when it's selected, or when
the exploded view or the assembly view is selected." Code: `src/cad/timeline/`. Values marked DEFAULT are in code
comments.

- **Where.** Docked under the floating toolbar, between it and the bottom of the view: while it shows, the 3D view gets
  shorter by its height (the renderer resizes; nothing covers the model), and it leaves the floating inspector's width
  on the right and the host's inset on the left. It shows while Explode or Assemble is on (the toolbar asks, the parts
  are apart, or a play runs) and stays 1.2 s after the parts come to rest together (DEFAULT), then goes.
- **The card.** `surface` with a 1 px `border` and the app's `radius`, the scene's ground (`sceneBackground`) around it;
  every label in the label face (`fontLabel`), uppercase, wide tracking. It collapses to one line (play, the title,
  the expand chevron); the choice is remembered per viewer in local storage (`uhd-viewer.timeline.collapsed`).
- **The header.** A round play/pause button (a `text`-coloured disc), loop (pressed: `accent` outline on
  `accentTint`), the title "STEP 6 / 9 · FASTEN TOP PLATE" with the step id, its parts, the time into the assembly and
  the speed under it ("Explode · all parts at once" in Explode mode), the EXPLODE slider with its value, and a chip:
  a replay clip's size ("replay loop · 12 joints × 120 samples · 5.6 KB": 4 bytes per joint per sample), else what
  plays (steps and joints, or the radial plan).
- **One time axis.** Assembly reads left to right: everything apart on the left, together on the right (the explode
  amount reversed). The playhead is the `accent`: a 2 px line across every track with a dot on top.
- **STEPS.** One chip per step that takes time, as wide as its share of the play: done steps on the `muted` fill,
  the current one an `accent` outline on `accentTint` with its words in `text` (the accent on its own wash is under
  4.5:1 in both themes), steps to come outlined only; a sub-assembly's step dashed; a narrow chip shows its number
  only (DEFAULT under 64 px). In Explode mode every part moves at once, so no chip is current; a click goes to that
  step and plays the steps.
- **Joints.** One row per joint (revolute, slider): hollow diamond keyframes (rest at the far left, each step's
  keyframe where that step ends), the segment the joint moves in, the moving one in the `accent`; a keyframe the hard
  stop held has a `drcWarning` ring. Its words: type, range in degrees or mm, easing, "clip" when a replay clip drives
  it ("revolute · 0° → 90° · ease in-out").
- **CONTACTS.** From the interference sweep (`protoboard interference --json`): one marker per pair of bodies that
  touch or overlap where no mate intends it, in `drcError`, at the first place it happens, with a red span to where it
  is last seen; an overlap is a filled octagon with a cross, a touch a ring (colour is never the only signal). The
  marker nearest the playhead carries its words ("prop touches camera hood · t 7.55 · from sweep"). No sweep run: the
  row says so.
- **Gestures.** Play/pause and loop drive the sequence player; the slider writes `explode.t` through the view state
  (the op log shows the person's gesture); a press on a step chip goes to that step; dragging on the tracks scrubs;
  Space plays or pauses and Left/Right step when the panel has focus.
- **Contrast** (test `cad-timeline-r3b.test.ts`, both themes): labels (`text`, `textMuted`) and the contacts'
  `drcError` at least 4.5:1 on the card; the playhead, the held ring and the play disc at least 3:1.

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
| Assembly timeline (panel, model, sheet) | `src/cad/timeline/` |
| Dimensions, angles, the Measure tool, explode path lines | `src/cad/dims/` (`record.ts`, `geometry.ts`, `layer.ts`, `paths.ts`, `measure.ts`, `style.ts`) |

## Open for review

- The paper bands were spread wider than the round-2 proposal so they read at the viewer's size (DEFAULT).
- The dark bands are the round-2 proposal; coloured parts get dark in the shaded band.
- The ink thresholds were tuned on the drone and ClientX at 1440x900; other scales may want other values.
- Whether the web app should follow the system by default or stay dark until a person chooses.
- R3-C: dimension and path dashes are sized in the world at the lines' mean depth (a long line in steep perspective
  has uneven dashes); whether a dimension should hide while the model is apart; the 7 px-per-character boxes the
  angle labels use to stay off each other.
