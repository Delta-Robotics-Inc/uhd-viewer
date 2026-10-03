# uhd-viewer

Standalone viewer for UHD (Universal Hardware Description) systems: modules,
interfaces, interface links, and harnesses. It depends on UHD and a neutral
view contract, not on ProtoBoard types.

Tracking: PB-770 (Track B) under PB-763 in the ProtoBoard Stack Linear project.

![Quadcopter, domain classification](docs/screenshots/01-quadcopter-domain.png)

![Fault scenario: DJI O4 on raw 6S](docs/screenshots/05-fault-o4-on-6s.png)

## Run

The viewer imports UHD source and library parts from a sibling checkout
(`../uhd`) until UHD ships a JSON form (PB-778).

```bash
# ../uhd on branch mark/pb-793-child-link-integrity (or later)
npm install
npm run dev          # http://localhost:5178
npm run build        # type-check, the app (dist/app) and the library (dist/lib)
npm test             # vitest: bundle loading, nets and boards, sample fixtures, the serve entrypoint, host options
npm run serve -- <bundle.json>   # the built app with one bundle (see "Serving and embedding")
```

Building and testing need `../uhd` only. The dev server's default bundle is the
quadcopter example in a sibling `../protoboard-cli` checkout (or `UHD_BUNDLE`);
without one, open the dev server with `?bundle=<url>`.

To open a particular view, pass URL parameters:

| Parameter | Example | Effect |
| --- | --- | --- |
| `mode` | `domain`, `drc`, `signal` | Selects the classification. |
| `detail` | `conductors` | Draws child links side by side. |
| `open` | `gnss_i2c,m1_phases` | Opens these links. |
| `drill` | `stack` | Opens a child module as the canvas. |
| `expand` | `stack` | Expands a child in place (the arms are expanded by default). |
| `grounds` | `1` | Draws ground links as wires rather than symbols. |
| `scenario` | `o4-on-vbat`, `frame-20mm-stack`, `gps-on-rx-uart`, `two-compasses`, `legacy-m10q` | Loads a fault or variant scenario. |
| `panel` | `checks` | Opens the system checks panel. |
| `select` | `node:gnss`, `link:m1_phases` | Selects a module or link. |
| `pair` | `gnss_uart` | Opens the pair view for a link. |
| `select` | `node::sda` | A board net is selected by its path (`:<net>`). |

## What the MVP covers

- **Canvas:** React Flow v12, using the alpha app's dark visual language: cards, status dots, a dot grid, ProtoMono and Kode Mono, and Lucide icons.
- **Links (D1, D3):** stored UHD `InterfaceLink`s route orthogonally with filleted corners and stubs at the ports.
  - The layout nudges parallel segments apart and places labels to avoid collisions.
  - Hand waypoints can override the automatic route.
- **Opening links (D4):** the chevron on a link label opens it. The child links (slot → leaf pin) show on the label, as conductors inside a sheath, and in the inspector.
- **Detail level (D5):** *bundled* shows one line with a count; *conductors* draws the child links in parallel with concentric fillets.
- **Ports (D6):** linked ports sit on the outline, on the side facing their counterpart and ordered to reduce crossings.
  - Unlinked ports are grouped by protocol ("UART ×3").
  - Mechanical ports are square.
  - Ground links show as ground symbols; *GND WIRES* draws them as wires instead.
- **Classification (D7):** domain, DRC health (from `validateLinks`), and electrical signal type, each with its own legend.
- **Hierarchy (D8, D9):**
  - Groups (dashed) and modules (solid) expand in place, and double-click toggles expansion.
  - Exports show as boundary ports, with dashed pass-through lines to the child's port.
  - *Open as canvas* drills into a module. Its exports become sheet ports on the canvas edges, and a breadcrumb in the header leads back.
- **Inspector:** by default it shows the hierarchy of modules and links. Selecting a module shows its details and interfaces; selecting a link shows its child links and diagnostics.
- **Layout:**
  - The hand layout lives in `src/layout/quadcopter.ts`; drill-in levels use an automatic layout.
  - Dragged positions are saved per level in local storage, and the toolbar can reset them.

- **Harness nodes (D2, board 04):** a link carried by a harness module is drawn through the harness pill: the XT60 lead, the DJI 3-in-1 cable, and the M3 stack hardware bus.
- **System checks:** the Checks panel lists `checkSystem` diagnostics: supply budgets, propulsion current, I2C addresses, interface reuse, harness connectors. Clicking one selects its link or module; in DRC mode errors turn links red and warnings yellow.
- **Scenarios:** the header switches between the nominal build and the fault scenarios defined in UHD. A banner explains the fault.
- **Evidence:** a selected part shows its audit result, performance facts, assumptions, source conflicts, open data gaps and sources, all from the part's committed `sources.json` and `verification.json`.
- **Pair view (board 08):** every stored link between two modules, left to right, with crossovers drawn as crossings and each side's unlinked interfaces listed.
- **Remapping child links (D4):** *REMAP* on a link swaps child slots (for example motor phases). The override is stored as `childLinks`, re-validated by UHD (a slot used twice is rejected), locked on the canvas, and kept in local storage.

Not yet built: dragging conductors on the canvas to remap.

## Design

- [`uhd-viewer-design.pen`](uhd-viewer-design.pen): Pencil design file with sample boards 01–08.
- [docs/design-direction.md](docs/design-direction.md): the agreed design decisions (D1–D11).
- [docs/uhd-model-support.md](docs/uhd-model-support.md): what the UHD model supports for each sample.
- `docs/screenshots/`: reference renders of the quadcopter.

## Layout of the code

| Path | Contents |
| --- | --- |
| `src/model/types.ts` | The neutral view contract (PB-784). |
| `src/model/from-uhd.ts` | Adapter from a UHD system `ModuleDef` to the view model. |
| `src/model/classification.ts` | Classification colours and legends. |
| `src/model/nets.ts` | Board nets: junction nodes, grouped membership lines, links derived over nets (PB-823). |
| `src/model/diagnostics.ts` | The viewer's own checks: the root, and each board on its own, re-based onto the root. |
| `src/model/outputs.ts` | Standard outputs by file name, pick-and-place parsing, component rectangles on PCB drawings. |
| `src/layout/graph-layout.ts` | Force layout for levels with nets. |
| `src/chrome/BoardInspector.tsx` | Package facts, pin table, net and derived-link details, board drawings with pan and zoom. |
| `src/cad/findings.ts` | Where a finding is on the 3D model. |
| `fixtures/` | Hand-made sample bundles and standard outputs for boards and enclosures (see its README). |
| `src/layout/layout.ts` | Node boxes, port placement, routing, segment separation, and label placement. |
| `src/canvas/routing.ts` | Pure geometry: orthogonal routes, fillets, and parallel offsets. |
| `src/canvas/*.tsx` | Nodes, ports, the link edge, and the canvas. |
| `src/chrome/Chrome.tsx` | Header, activity bar, inspector, toolbar, and legend. |
| `src/api.ts` | The host contract: `ViewerOptions`, `ViewerLayout`, `ViewerHandle`. |
| `src/source/source.ts` | Bundle loading and the default artifact resolver. |
| `src/main.tsx`, `src/lib.tsx` | The standalone app's entry and the library entry (`mountViewer`). |
| `bin/` | `uhd-viewer serve` (`serve.mjs` holds the server). |

## 3D view (PB-775)

`?view=3d` (or DIAGRAM | 3D in the header) shows the system assembled from its
UHD links: every mechanical link with frames on both ends is a mate
(`assemble` in UHD), CAD bodies are the modules' GLB artifacts, and interface
geometry is resolved per binding direction:

- **D1 FEATURE** — named sub-shape in the body artifact (build123d STEP/GLB
  names, vendor component names; KCL tags are listed as unchecked until the
  KCL is exported)
- **D2 ARTIFACT** — the interface's own `interfaces/<id>.glb`
- **D3 PROCEDURAL** — drawn from the interface's parameters at its frame

Click a module to see each interface's frame and binding status; selecting an
interface also highlights its mated counterpart (e.g. motor face ↔ arm pad).
ASSEMBLED / EXPLODED animates every module along the normal of the mate that placed it (hardware comes apart along its fastener stack);
LABELS shows callouts with leaders for modules, harnesses/hardware and interfaces (menu to pick which);
FRAMES shows every interface frame; CABLES shows the routed wire harnesses;
HARDWARE places the stack harness's fasteners and checks the screw stack-up;
FOCUS looks along the selected interface's normal.

**Cables are harness artifacts.** A wire harness whose end interfaces carry
frames has its own routed body (a GLB in assembly-root coordinates, one node
per conductor, plug housing, solder joint and tinned tip, written by
ProtoBoard's `@protoboard/ext-harness-cad`). UHD `assemble` places it from the
part its first end lands on (`assembly.harnesses`) and checks every other end;
the viewer draws that GLB at that placement, keeps the generator's colours and
sets the surface per node kind (satin insulation, metal solder). Selecting a
cable shows its length, route, bend radius, clearance and each end's state
(ANCHOR / MATCHES / STALE). Cables fade out when the model explodes: they are
routed for the assembled model. Nothing about a cable is drawn from outside
the bundle.

URL: `view=3d&body=arm_fl/motor&iface=base_mount&dir=feature&explode=14&focus=1`
(also `mate=<link>`, `harness=<path>`, `frames=1`, `wires=0`, `hardware=0`). The vendor GNSS GLB
is generated locally by `library/cad/py/gnss_vendor.py` in the UHD repo.

Stills for review: `node scripts/capture-cad-stills.mjs <out-dir>` renders a
fixed set of shots (assembled from four sides, exploded, labels, stack and
arm close-ups) through `window.__cad.set(...)`; `SHOTS=<regex>` picks some.

Screenshots: `docs/screenshots/cad/`.

### Video

`node scripts/capture-cad-video.mjs docs/video/quadcopter-3d.mp4` records the
3D view (rotation, assembled ⇄ exploded, labels on/off) through
`window.__cad.set(...)` in presentation mode (`?view=3d&present=1`). Needs
the dev server, Google Chrome and an ffmpeg binary (`FFMPEG=...`; e.g. the one
bundled by the `imageio-ffmpeg` Python package). The mp4 is not committed.

## Boards, nets and enclosures (PB-823)

The viewer shows custom boards and enclosures from UHD and the standard
outputs their providers export (protoboard-cli
`docs/specs/tool-integrations.md` §8), read as ordinary artifacts and found by
their fixed file names. It never reads a tool's native files. Design
decisions: D14–D18 in [docs/design-direction.md](docs/design-direction.md).
Samples to try it on: [fixtures/](fixtures/README.md).

- **Diagram.** A board drills in like any module. Each net (UHD `Net`
  interface) is a junction; each component on it has one port and one line
  to it, whose children are its pins. Ground nets are ground symbols unless
  *GND wires* is on. Links UHD derives over the nets are listed by name and
  carried by the lines they run over, so `bus_incomplete` shows as
  `harness_wiring` does on a cable. Every board is checked on its own as
  well as the root; its findings are tagged `IN BOARD` in the checks panel
  and open the board when clicked.
- **Inspector.** A component shows its package facts (`partPackage`) and a
  pin table with each pin's net. A board, or a component on one, shows the
  board's drawings (`pcb-top.svg`, `pcb-bottom.svg`, `schematic.svg`) with
  pan and zoom: the selected component is marked from `pnp.csv`, and a
  click on a component selects it. PCB drawings are taken to be in board
  millimetres (top: board (x, y) at (x, −y); bottom, seen from below:
  (−x, −y)); a drawing that is not is shown without marks.
- **3D.** A board's `board.glb` is its body, placed by its own mates, with
  its components inside it (selectable by instance path). An enclosure's
  `body.glb` with named bodies (`back`, `lid`) comes apart when exploded.
  *Section* cuts the model across X, Y or Z; *X-ray* makes bodies that hold
  others see-through; *Findings* pins errors and warnings (the viewer's own
  and the host's fit and route findings) where they are. It is on by default
  only when the host sent findings that land on the model.

URL: `view=3d&section=y&at=0.4` (`flip=1` keeps the other side), `xray=1`,
`findings=1` or `findings=0`, `body=board&component=u1`.

Screenshots: `node scripts/capture-board-shots.mjs <dev-server-url> <out-dir>`
renders the board and enclosure views of the fixtures.

## Input: a UHD bundle (PB-800)

The viewer loads one UHD bundle (`uhd.bundle/v0`, defined in `@deltarobotics/uhd`)
and nothing else: a root, its definitions, scenarios, per-definition artifact
bases, producer diagnostics and display hints (layout, labels, placement
hints, appearance, keyed by instance path). It never imports a project.

- `?bundle=<url>` picks the bundle; failing that, the bundle URL a server
  injected into the page (`uhd-viewer serve`). The development default is the
  ProtoBoard quadcopter project's build output (`protoboard build` writes
  `.protoboard/build/uhd-bundle.json`); override it with `UHD_BUNDLE=<path>`.
  A production build has no default.
- Absolute filesystem artifact bases are served through Vite's `/@fs` route in
  development only. A production build cannot fetch them: serve the bundle
  with `uhd-viewer serve`, or give `mountViewer` a resolver. URL bases are used
  as they are.
- Producer diagnostics (the bundle's `diagnostics`) and a host's are listed in
  the checks panel under FROM THE PRODUCER, for the nominal build. Findings
  from `uhd/checkSystem` are left out there, since the viewer runs those checks
  itself for every scenario.
- Part evidence: the inspector shows a part's evidence traits from the bundle.
  The audit result and source list come from the part's `sources.json` and
  `verification.json`, which bundles do not carry yet. In development they are
  read from the sibling UHD checkout's part library
  (`src/model/library-evidence.ts`); production builds do not contain the
  library and show the traits only.
- Without display hints, the diagram lays itself out and 3D labels are derived
  from instance names, harness children and mates; the assembly is placed from
  the top-level module with the most interface frames.

Boundary: `protoboard-cli/docs/specs/uhd-boundary.md`.

## Serving and embedding (PB-814)

`npm run build` writes two things:

- `dist/app`: the standalone viewer, with relative asset URLs so it can be
  served from any path. It loads `?bundle=<url>` or the bundle URL a server
  injects, and resolves artifacts over HTTP.
- `dist/lib`: `uhd-viewer.js` (one ES module that includes React, Three and
  React Flow), `uhd-viewer.css`, and type declarations.

### `uhd-viewer serve`

```bash
uhd-viewer serve <bundle.json> [--port 5179] [--host 127.0.0.1] [--open]
# from this checkout: npm run build && npm run serve -- <bundle.json>
```

A small Node server (`bin/serve.mjs`, no dependencies) for the built app, the
bundle and its artifacts:

- `/` is the app, with the bundle URL injected as
  `<script type="application/json" id="uhd-viewer-config">`.
- `/uhd-bundle.json` is the bundle with every filesystem artifact base
  rewritten to a URL on this server, `/artifacts/<name>/` (named after the
  base's folder: `quadcopter-5in`, `uhd`). URL bases are left alone, and no
  local path is sent to the browser.
- `/artifacts/<name>/<path>` answers only for files the bundle references as
  artifacts, and only if the file's real path stays inside its base. Anything
  else in the folder (`.env`, sources) is a 404; a symlink pointing out of the
  base is a 403.
- The bundle file is re-read when it changes, so a rebuild shows on reload.
- It binds to 127.0.0.1 and only answers requests addressed to a loopback
  name, so a web page elsewhere cannot read the files through DNS rebinding.
  `--host 0.0.0.0` exposes the artifacts to the network and accepts any host.

Hosts with their own server can use the same handler for the viewer's routes:
`viewerHandler({ bundleFile })` from `@deltarobotics/uhd-viewer/serve`. Its
types are in `bin/serve.d.mts` (written by hand; a test checks they name
exactly what the module exports).

### `mountViewer`

```ts
import { mountViewer } from "@deltarobotics/uhd-viewer";
import "@deltarobotics/uhd-viewer/style.css";

const viewer = mountViewer(document.getElementById("viewer")!, {
  bundleUrl: "/uhd-bundle.json",          // or bundle: <a parsed UhdBundle>
  resolveArtifact: (definitionId, filePath, fallback) => fallback(definitionId, filePath),
  diagnostics: hostFindings,              // UhdBundleDiagnostic[], listed with the producer's
  layout: savedEdits,                     // ViewerLayout to show
  onLayoutChange: (layout) => save(layout),
});
viewer.update({ bundle: rebuilt });       // e.g. after a rebuild
viewer.update({ layout: reloaded });      // e.g. the saved layout changed on disk
viewer.unmount();
```

- The element needs a height; the viewer fills it.
- `resolveArtifact` replaces or extends the default resolver (the bundle's
  artifact bases); `fallback` is the default.
- `diagnostics` are listed with the bundle's own under *FROM THE PRODUCER*.
  Like those, they describe the nominal build, so they show for the nominal
  scenario only.
- `update` merges its options into the current ones. Giving `bundleUrl`
  without `bundle` drops a bundle given earlier and loads from the URL.
- `onLayoutChange` receives, debounced, every layout edit the user makes:
  dragged node positions and link waypoints / label positions, per drill level
  (`ViewerLayout`). With a handler the host owns the layout: the viewer neither
  reads nor writes it in local storage. Without one, local storage is used as
  before. Child-link remaps (*REMAP*) stay in local storage either way.
- A different `layout` given to `update` replaces the viewer's edits (an edit
  still waiting for its debounce is dropped). The same layout coming back, as
  after the host saves what it was sent and reloads it, changes nothing and is
  not sent again.
- View state still comes from the page's URL parameters (the table under
  "Run").
- The stylesheet is not scoped yet: it sets `html`, `body`, `button` and the
  fonts, so the viewer is best given a page of its own (as `protoboard dev`
  will).

### Checking a build

`node scripts/check-render.mjs <viewer-url> <out-dir>` opens the diagram, two
inspector artifact previews, the checks panel and the 3D view in headless
Chrome, saves a PNG of each with `summary.json`, and exits 1 if any request
failed (a missing favicon aside). `node scripts/check-render.mjs compare
<dir-a> <dir-b>` compares two runs pixel by pixel, for example the dev server
against `uhd-viewer serve` on the same bundle. On the quadcopter bundle the
two match except for the evidence audit line, which only development shows
(see "Input").

`node scripts/check-render.mjs host <bundle.json> <out-dir>` checks the library
build as a host uses it: a page that mounts `dist/lib` with its own
diagnostics, resolver and `onLayoutChange`, next to `viewerHandler`. It checks
that the host's diagnostics are listed and replaced by `update`, that a dragged
node reaches `onLayoutChange` and not local storage, that a layout passed back
through `update` moves the node and is not sent again, that the 3D view
resolves its artifacts through the host's resolver, and that no request fails.
It writes two PNGs and `host-summary.json`, and exits 1 on any failure.
