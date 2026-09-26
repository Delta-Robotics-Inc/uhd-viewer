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
npm run build        # type-check + production bundle
```

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

Not yet built: dragging conductors on the canvas to remap, the `serve`
entrypoint, and the 3D/CAD view.

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
| `src/layout/layout.ts` | Node boxes, port placement, routing, segment separation, and label placement. |
| `src/canvas/routing.ts` | Pure geometry: orthogonal routes, fillets, and parallel offsets. |
| `src/canvas/*.tsx` | Nodes, ports, the link edge, and the canvas. |
| `src/chrome/Chrome.tsx` | Header, activity bar, inspector, toolbar, and legend. |
