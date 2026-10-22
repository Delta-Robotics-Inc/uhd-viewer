# UHD viewer design direction

Status: direction agreed with the owner on 2026-09-26; samples in
[`uhd-viewer-design.pen`](../uhd-viewer-design.pen). Tracking: PB-783 (B1) under
PB-770. This covers the 2D system diagram. The CAD/spatial view is PB-788 (B6).

Priority order for design work:

1. The interface and harness system (links, opening links, detail level, topologies).
2. Module and submodule display (groups, real modules with children, drilling in).
3. Everything else (inspector, diagnostics, and the overall layout).

Each sample in the Pencil file carries a **UHD model** note: supported, partial,
gap, or viewer layout (not UHD). The notes are collected in
[uhd-model-support.md](uhd-model-support.md). The design is locked first; the
UHD model gaps are addressed afterwards (Track A / PB-778). Boards, nets and
enclosures (D14–D18) were added with PB-823 and await the owner's review.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Module | Any hardware unit. Can contain submodules. |
| Interface | A connectable point on a module. It can be composed of child interfaces through slots (I2C → SDA, SCL). |
| Interface link | A connection between two interfaces. A 1:1 link needs no harness. A composed link carries child links (SDA↔SDA, SCL↔SCL). |
| Harness | A specialised module that physically carries interface links between two or more modules: a cable, bus backbone, splice, or switch. |
| Group | A module with no interfaces of its own that exports all of its children's interfaces by default. |
| Export | A child interface surfaced on its parent's boundary so neighbours can attach to it. |
| Classification | The rule that colours links and ports (domain, DRC health, signal type…). |

## Decisions

### D1. Interface links exist without harnesses

Two modules can connect their interfaces directly (board 01). A harness is
only introduced when there is something physical to represent, such as a cable
with connectors, a bus backbone, a splice, or a switch. Child interfaces have
their own links underneath a 1:1 parent link.

### D2. Harnesses are specialised modules drawn as their carrier line

At the data layer a harness should differ little from a module: it has ports,
parameters, artifacts, and geometry. On the graph it is drawn as the carrier
line, with a **harness node** (pill) that opens it like a module. The harness's
own ports (connector ends) are small squares on the line (board 04).

Topologies to support first:

- **Point-to-point cable**: two ends, with the cable's own identity.
- **Bus** (many-to-many): a trunk line with drops, and per-drop labels (e.g. I2C addresses).
- **Split / splice** (one-to-many): a source feeding a splice node that branches to drops.
- **OR / switch** (one of N): the selected branch is solid and alternatives are dashed.

Other topologies (daisy chain, star, ring) are added when a real project needs
them. Every harness must correspond to something physical.

### D3. Links route orthogonally with filleted corners

Links do not use bezier curves as the alpha app does. They route with 90° turns
and filleted corners, like an EDA schematic, and support user-editable
waypoints. Every link has three independently positioned labels: the interface
name at each end and the link name on the line (board 01). Route and label
positions are viewer layout data, not UHD.

### D4. Links can be opened like cutting a cable

A composed link (I2C, UART, 3-phase) opens in place. The single line splits
into its child links, each ending on a child port, and rejoins into one line
when collapsed (board 02, following the owner's sketch in the file's first
frame). While a link is open:

- child links can be remapped by dragging a conductor end onto another child
  port, for example to swap motor phases; a manual mapping shows a lock badge;
- crossovers such as UART TX→RX are drawn as crossings;
- an unmapped child stays visible as an open `?` socket instead of being hidden.

### D5. Detail level is a per-link or global preference

A link can be drawn **bundled** (one line with a conductor count, e.g. `3φ ×3`)
or as **conductors** (every child link drawn side by side along the same route
with concentric fillets). An automatic mode chooses by zoom level. Opening a
link (D4) is the editable form; the conductor view is read-only detail
(board 03).

### D6. Ports: show all, or group by type

- Modules with few interfaces show every port.
- Modules with many interfaces show one grouped port per interface type
  (`UART ×6`, `DIGITAL ×10`). Connecting an interface pops a concrete port out of
  the group and decrements the count.
- The default-visible set, grouping, side, and order are configurable per module.
- Cards grow to fit their ports unless a geometry override fixes the size and
  shape. Modules keep the alpha app's shape presets (rectangle, rounded, circle,
  custom outline).

Proposal, still to confirm: port glyph shape encodes domain (circle electrical,
square mechanical), so the domain stays visible under any colour classification
(board 05).

### D7. Interface/harness classification

Links and ports are coloured by a selectable **classification** (board 06):

- **Domain** is the default: electrical, mechanical, pneumatic, hydraulic,
  thermal, network.
- **DRC health** uses the alpha app's four states: configured, partial,
  incompatible, not configured.
- **Domain-specific** modes, such as electrical signal type, colour one domain
  by interface type and fade the others.

Each mode ships with its own legend; a general legend builder comes later.
Modules get a parallel classification system later (lifecycle, origin: local vs
catalog).

### D8. Hierarchy: groups and real modules

An expanded module shows its submodules one level below (board 07).

- **Group**: dashed outline and no interfaces of its own. Children's interfaces
  are exported to the boundary as pass-through ports, and neighbours attach
  there.
- **Real module**: solid outline with its own boundary interfaces, linked
  internally to its children and externally to neighbours. Unlinked boundary
  ports stay visible.

### D9. Drilling in: expand in place, or replace the canvas

Both drill modes are supported.

- In **replace-canvas** mode, the parent's boundary ports appear as sheet ports
  on the canvas edge.
- The header always shows a breadcrumb path (`QUADCOPTER / FC STACK / ESC 4-IN-1`).
- The inspector's default view shows the hierarchy of modules and harnesses.
- A selected module (or the harness a selected link runs through) shows its
  artifacts: the thumbnail (an image artifact tagged `thumbnail`, else any
  image that is not a datasheet page), the body CAD in a small viewer that
  turns slowly until grabbed and then orbits with the pointer, and links to
  its other CAD and drawing files. An assembly without CAD of its own (the
  FC + ESC stack, an arm) shows its parts' artifacts, one part at a time.

### D10. The pair view is a first-class secondary view

A left-to-right, wire-viz style view of exactly two modules, based on
protoboard.ai/validate and the UHD ASCII visualizer (board 08). It opens from
any link in the system diagram and is rendered from `PairValidationResult`:

- fixed A and B columns, with ports on their inner edges;
- one shared region per connection, with a state pill;
- the parent link drawn thick and child conductors thin;
- a census of unconnected interfaces, and a verdict.

The dynamic system diagram remains the main view.

### D11. Application layout follows the alpha app (not scoped yet)

The layout follows the alpha app: a left activity menu, the canvas in the
centre, a right-hand inspector, and a toolbar at the bottom, with the breadcrumb
in the header. Its detailed design is deferred.

### D12. Harness regions, bundles and routing (board 09, PB-803)

- **Harness regions.** A harness is part of the link it carries: module →
  link line → harness region → link line → module. The region is tight to
  its own lines and follows their shape (a bus region follows the spine and
  taps), with a dotted outline and a light fill. The harness name sits outside
  it as a small tab; lengths, gauges, members and hardware lists belong in the
  inspector, not on the canvas.
- **Bundles, basic mode.** One line at each module (it is one link).
  Expanded, it breaks out into labelled lanes, one per child interface, all
  leaving the line at the same point and rejoining it at the same point.
- **Bundles, detailed mode (ribbon).** Every signal end to end at a tight
  pitch in its own colour, over a soft band in the link's colour. The ends are
  slim handles whose dots are only slightly wider than the lines, and each line
  starts at its own dot. Expanded, the ribbon curves out into labelled lanes on
  the grid and back in.
- **Expanding through a harness (PB-805).** Every multi-child link expands
  the same way whether or not a harness carries it: one line at each module,
  one lane per child interface in the middle. When a harness carries it, the
  dotted region grows to hug the expanded lanes (it is traced around them, so
  a bus follows its spine and taps, and a split follows each branch). Taps and
  splits carry every lane; a junction dot marks where a lane joins its own
  net, and a small gap marks a crossing with no connection. A cable that
  carries several links (the DJI 3-in-1) is one line from socket to socket;
  its lanes are the links derived from its conductors, and a lane that is
  itself a bundle (UART5: TX · RX) has its own toggle.
- **Levels: a breakout per level of the hierarchy, in both modes.**
  Expanding a link is one breakout: its child interfaces leave the line
  together (siblings never stagger). A child that itself has children stays
  one line (basic, drawn thicker) or one sub-ribbon of its conductors (ribbon),
  named for what it is ("UART", not "UART1"), with its own toggle. Opening it
  is a second, independent breakout a level further in: the child runs as a
  single line first, carrying its name, then splits into its own children.
  Each level has its own fan and its own lane names at the start of its
  straight part, so the depth of the hierarchy reads from the line itself. A
  collapsed link shows no child count: the expansion is one click away.
- **Label and toggle.** The link label sits beside the expand/collapse toggle,
  a rounded box sized to what it spans (the line or ribbon when collapsed,
  every lane when expanded). The toggles of every open level **overlap at the
  same point**: each nested box spans its own lanes and sits on top of the
  box that contains it; a box whose centre is covered carries its − in a
  small cap on the label's side. Label and toggles form one handle that
  defaults to the middle of the longest straight stretch and **can be dragged
  along the link's path** (by the label or any toggle; a press without a drag
  is a click). Dragging the label **across the line** puts it on the other
  side (the caps follow it). Its position and side are stored per link
  (`labelT`, `labelFlip`) and follow the route when it is re-routed.
- **Expansion length.** An expansion sits on one straight stretch, never in a
  bend. Its straight part is at least what the lane names need and at most a
  little more, so it can slide along a long stretch. On a short stretch the
  fans steepen first; the toggle then moves past the names instead of
  between them; only a stretch the user forces it onto that is shorter still
  drops the names. Placed automatically, it moves to the nearest stretch it
  fits on; placed by the user, it stays where it was put.
- **Nothing in a bend.** Harness ends (connector handles and end marks),
  toggles and labels are kept a fillet radius plus half their size clear of
  every corner. A harness region grown to take in an expansion keeps its ends
  on straight stretches. A ribbon cannot sidestep in less than about its own
  width, so short S-jogs in a ribbon become a gentle diagonal, and its fillet
  radius grows with its width so the inner conductor still turns round.
- **Ports under a ribbon.** In ribbon mode a multi-conductor link ends in its
  own pin handle, which replaces the port dot (no dot under the handle).
- **Implemented (PB-803).** `src/canvas/LinkEdge.tsx` (basic and ribbon
  modes, lanes, nested toggles, harness regions traced around their
  contents, end marks and pin handles, draggable label + toggle),
  `src/canvas/geometry.ts` (arc-length geometry, fans, region tracing) and
  `src/layout/router.ts` (grid A*: cards avoided, bends and crossings
  penalised, parallel runs kept apart, pinned waypoints visited in order).
  A cable with two connector ends is one link; its lanes are the links UHD
  derives through it and its conductors are the mated positions. Label
  positions and pins persist per level and reset with the canvas reset.
- **Waypoints.** Pinned waypoints are released by double-clicking them, or
  all at once with the reset button on the selected link's label.
- **Routing.** A 16 px grid for nodes, ports, segments and bends. The router
  avoids modules and labels, penalises crossings and bends, and keeps parallel
  runs one grid step apart. Its bends are automatic waypoints (shown when a
  link is selected); dragging one pins it, it is saved in the display file, and
  the router must pass through it from then on.

### D13. Text reads upright or bottom-to-top (CAD convention)

All text on the canvas either reads upright (left to right) or is turned
90° anticlockwise so it reads bottom to top, with the top of the letters
facing left. It is never upside down or turned clockwise, whichever way a
link travels, so a drawing reads from the bottom edge or the right edge, as
in standard CAD drawing practice (ISO 128 / ASME Y14.2 unidirectional and
aligned text).

- **Link and harness labels run parallel to their line.** On a horizontal
  stretch the link label sits above the toggle, upright; on a vertical one it
  sits to the right, turned to read bottom to top. Either can be dragged
  across the line to the other side (below, or left).
- **Harness tabs work like link labels.** A tab sits outside its region on a
  straight stretch, by default the long one nearest the middle of the harness
  and on the side opposite the link label, turned like the label on a
  vertical stretch. It can be dragged along the harness or across it
  (`tabT`, `tabFlip`).
- **Lane names run along their lane**, upright or bottom to top, starting
  where the straight part begins and running into it whichever way the link
  travels.
- **Everything else is upright**: port labels (on every side of a card),
  module titles, tags, the chrome and the 3D callouts (screen-space cards).
- Implemented in `src/canvas/LinkEdge.tsx`: only `rotate(-90deg)` is ever
  applied to text.

### D14. Board nets are junctions; memberships are grouped (PB-823)

A board is a module like any other: it drills in (replace canvas) and
expands in place. Its nets are `Net` interfaces on the board itself (UHD
`docs/boards-and-nets.md`), so they are drawn as nodes of their own, not as
lines between every pair of pins.

- **A net is a junction:** a small rounded card with the net's name, in the
  net's colour (power, ground, or the bus it carries in signal mode), with
  one port per component on it. It grows only as much as its ports need.
- **One line per component and net.** A component gets one port per net it
  touches, named for the net, and one line to the junction. The line's
  children are the component's pins on that net (designator and name); it
  opens like any multi-child link, one lane per pin. Its label is the pin's
  name, two names joined (`VDD/VDDIO`), or the first and a count
  (`IOVDD +3`).
- **Ground nets follow the ground convention.** A net with a ground pin and
  no supply pin is drawn as ground symbols at its members' ports; *GND
  wires* draws it as a dashed junction with lines.
- **Layout.** A level with nets is laid out by a deterministic force layout
  (`src/layout/graph-layout.ts`): each junction settles among the components
  it joins, then cards are pulled apart to a margin. Sheet ports sit on the
  left or right edge, level with the child they expose. Hand layouts and
  drags override it as on any level.
- **Fit.** The diagram fits clear of the floating chrome: the header, the
  toolbar and, when it is open, the inspector, with a zoom cap so a level of
  two modules is not blown up.

### D15. Links derived over nets are named, not drawn (PB-823)

UHD derives functional links over a board's nets (an I2C bus, a regulator
to its loads). Their ids name every membership they run over, so they are
never shown; their names are ("I2C 0 ↔ Primary I2C (target)").

- They are not lines of their own: the grouped lines they run over carry
  their state. A line also carries every pin of either end, wherever it
  landed, so a bus with SDx on the INT1 net marks the INT1 line too.
- `bus_incomplete` and `harness_wiring` therefore read the same way on a
  board as on a cable: the lines turn incompatible, the finding is in their
  diagnostics and on the derived link.
- The inspector lists them by name: all of them in the hierarchy (*FUNCTIONAL
  LINKS (DERIVED)*), those of a component, those over a net, those over a
  line. Selecting one lights the lines it runs over and shows its ends,
  nets, conductors and findings.
- **Checks per board.** Derivation stops at a module boundary, so the viewer
  checks every module that declares nets on its own, as well as the root.
  A board's findings carry its path; the checks panel tags them `IN BOARD`
  and clicking one opens the board and selects what it names.

### D16. A board's inspector: package, pins and its drawings (PB-823)

- **Package facts** (UHD `partPackage`): name, code, pin count and exposed
  pad, pitch, body size, the source and any stated assumption.
- **Pin table:** every pin with a designator in package order, its type as a
  datasheet's pin table names it, and the net it is on at this level.
- **Board drawings:** the circuit standard outputs `pcb-top.svg`,
  `pcb-bottom.svg` and `schematic.svg` in tabs, with scroll to zoom, drag to
  pan and double-click to reset. A drawing is shown as an image: its markup
  never enters the page. A selected component is marked on the PCB views
  and brought into view, on the side it is placed (the tab follows it); a
  click on a component selects it, and from the parent level opens the
  board with it selected.
- **How marks are placed:** from `pnp.csv` (instance, position, rotation,
  side), sized by the part's package (length × width, turned), else by the
  manifest feature named by the instance path. PCB drawings are taken to be
  in board millimetres: the top view draws board (x, y) at (x, −y), the
  bottom view, seen from below, at (−x, −y). A drawing whose viewBox does not
  hold its side's components is shown without marks and says so. The
  schematic has no marks: nothing ties its coordinates to the board yet.
- Outputs are found by their fixed file names, never by the tool that wrote
  them. Files tagged `sample` carry a SAMPLE tag. Board drawings are never a
  module's thumbnail.

### D17. Boards and enclosures in 3D (PB-823)

- **A board is one body.** A module with children and a body GLB of its own
  (`board.glb`) is placed by its own mates and drawn whole; its components
  are drawn inside it, not placed one by one. Nodes named by a component's
  instance path are bodies (the circuit manifest names them so), not
  feature pads; selecting a component (from the body's component list or by
  clicking it) lights it. A bundle whose root has a body is placed from it.
- **Outputs keep their colours.** A body GLB that defines materials keeps
  them unless the display hints give its definition an appearance (vendor
  models already did); our own uncoloured CAD still takes the part's
  appearance.
- **Section:** a plane across X, Y or Z of the assembled bounds, moved with
  a slider; by default it keeps the side away from the camera, so the cut
  faces the viewer. Cut faces are left open (no caps); the floor grid hides
  while sectioning.
- **X-ray:** bodies whose bounds hold another body's centre (an enclosure
  round its board) become see-through; nothing is named to decide it.
- **Explode separates a cad output's named bodies.** A cad standard output
  (`body.glb` with a `body.manifest.json` generated from it) whose manifest
  lists several named `bodies` (an enclosure's `back` and `lid`) comes apart:
  the largest stays, each other moves away along the line between their
  centres, 2.2 × a mate's step, so a lid clears what sits inside. Vendor and
  library part GLBs stay rigid even when their manifests name several bodies
  (a motor's bell and stator, a prop's hub and blades). Small assemblies
  (under 120 mm across) explode in proportion to their size and are framed
  to fit when they load.
- Controls that do nothing for a model are not shown (*Hardware* without
  fastener stacks, *Cables* without routed harnesses, *Findings* without
  findings). The new ones (section, x-ray) are icon-only to keep the toolbar
  on one line, centred on the area the inspector leaves visible.

### D18. Findings on the model (PB-823)

Errors and warnings that name something placed are pinned to it as callouts
in the label layer (D13 upright cards), with a leader to a dot in the
severity colour; the card's edge is the severity colour too. They show with
or without the other labels (*Findings* toggle) and are listed in the
assembly inspector. What a finding names decides where it sits: an
interface's frame (`enclosure:swd_window`), a component inside a body by its
manifest feature (`board/l1`), a mate's frame (`link:<id>`), else the body's
centre. Clicking one selects what it names. Both the viewer's own checks
and a host's (a cad provider's fit and route findings) are pinned. The
*Findings* toggle starts on only when the host sent findings that land on
the model, so a model whose only findings are the viewer's own checks (the
quadcopter's propulsion current warning) opens as before; `findings=1|0`
overrides it.

## Visual foundations

These are defined as Pencil variables in the design file:

- **Surfaces:** carried over from the alpha dark theme (canvas `#1c1c1c`, card
  `#2f2f2f`/`#44403c`, brand `#ff5c00`).
- **Domain palette:** electrical `#f5a524`, mechanical `#94a3b8`, pneumatic
  `#22d3ee`, hydraulic `#6366f1`, thermal `#f43f5e`, network `#a78bfa`.
- **DRC palette:** carried over from alpha (`#22c55e`, `#eed202`, `#ef4444`,
  `#6e7681`).
- **Signal-type palette:** a separate set of variables (`sig-*`).
- **Type:** Kode Mono throughout, bold (700) for headers and display labels.
  (ProtoMono, the alpha app's header font, is commercial and was replaced by
  bold Kode Mono on 2026-10-21; the open code ships only Kode Mono, under the
  SIL Open Font License.)
- **Icons:** Lucide.

## Open questions

- Should port glyph shape encode domain (D6 proposal)?
- Is RF/optical its own domain or an electrical sub-type?
- Is module shape a definition hint in UHD, or purely layout?
- Should the pair view and the website's /validate share one renderer package?
- How do we visualise interface dependencies (interfaces filling other
  interfaces' slots)? Intentionally deferred.
- Should PCB drawings state their board-millimetre mapping explicitly (an
  agreed attribute or a manifest field) rather than by convention, and should
  a schematic carry instance paths so a component can be marked on it?
- Section caps (filled cut faces) for the 3D section plane.
