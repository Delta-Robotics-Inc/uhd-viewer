# uhd-viewer

Standalone viewer for UHD (Universal Hardware Description) systems: modules,
interfaces, interface links, and harnesses. It depends on UHD and a neutral
view contract, not on ProtoBoard types.

Tracking: PB-770 (Track B) under PB-763 in the ProtoBoard Stack Linear project.

![Quadcopter, domain classification](docs/screenshots/01-quadcopter-domain.png)

## Run

The viewer imports UHD source and library parts from a sibling checkout
(`../uhd`) until UHD ships a JSON form (PB-778).

```bash
# ../uhd on branch mark/pb-782-quadcopter-system (or later)
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

Not yet built: the pair view (board 08), editing child links from the canvas,
harness nodes (board 04; UHD harness roles exist now), the `serve` entrypoint,
and artifact links.

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
