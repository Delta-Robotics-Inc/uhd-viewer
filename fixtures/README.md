# Sample fixtures: a board and an enclosure

**Everything under `imu-pod/` is a hand-made sample.** It exists so the
viewer's board and enclosure views (PB-823) can be built and tested before
the real `circuit` and `cad` providers write standard outputs. No file here
was produced by a PCB or CAD tool, and nothing here is a design to build.

Regenerate after changing `src/` or the UHD fixture board:

```bash
node scripts/build-fixtures.mjs     # writes imu-pod/
npm test                            # test/fixtures.test.ts fails while they differ
```

## The bundles

| File | Root | What it exercises |
| --- | --- | --- |
| `imu-pod/imu-board.bundle.json` | the board | A board as the bundle's root: nets, derived links, package facts, board drawings, the board's own body in 3D |
| `imu-pod/uhd-bundle.json` | an IMU pod: the board in a two-part enclosure | A board drilled into, the board placed in the enclosure by its mounting holes, section, x-ray, the lid exploded off, fit and route findings on the model |

Open one with the dev server:
`http://localhost:5178/?bundle=/@fs/<this checkout>/fixtures/imu-pod/uhd-bundle.json`
(or `npm run build && npm run serve -- fixtures/imu-pod/uhd-bundle.json`).

Both have a scenario, *IMU SDx and INT1 swapped*: the IMU's SDx (pin 14)
and INT1 (pin 4) are joined to each other's nets, the case UHD's own
`bus_incomplete` test uses. The I2C link derived over the nets is then
incomplete.

## What is the UHD fixture and what is added

- **The board** is UHD's `fixture-imu-board` (`uhd/test/fixtures/imu-board.ts`:
  RP2040 + BMI270 on I2C, TPS63020 buck-boost, its sources cited there),
  unchanged except for what a project adds once a board is designed: a
  mounting-hole interface (`mount`, two M2 holes 23 mm apart, with its frame
  and a feature ref into `board.glb`), its size (28 × 18 × 1.6 mm), the
  standard outputs as artifacts, and an assumption trait saying the
  placement is hand-made. It is renamed `sample-imu-board` so it is not
  mistaken for the fixture itself.
- **The parts** are the fixture's, as UHD defines them, without their
  artifacts: their CAD files live in the UHD part library, which these
  bundles do not ship.
- **The enclosure** (`sample-imu-enclosure`) is a sample definition written
  here: `board_mount` (two bosses), `cable_entry` (an opening for the
  battery lead) and `swd_window` (an opening in the lid over the SWD pads),
  each bound to a feature of `body.glb`. Wall, floor and boss sizes and the
  PLA density are assumptions, stated as traits.
- **The findings** (`diagnostics` in `uhd-bundle.json`, validator
  `sample/cad:check (hand-made)`) are worked out from the sample geometry,
  as a cad provider's check would report them. The SWD window is placed
  0.8 mm off the pads on purpose, so `FIT_OPENING_OFFSET` is true of the
  sample.

## The standard outputs

Names follow protoboard-cli `docs/specs/tool-integrations.md` §8.

| File | How it was made |
| --- | --- |
| `board/out/pnp.csv` | Hand-chosen positions (`src/placement.ts`), keyed by instance path |
| `board/out/bom.csv` | One row per component, from the UHD definitions |
| `board/out/netlist.json` | `protoboard.netlist/v0`, from the board's membership links |
| `board/out/board.manifest.json` | `outline`, each component by instance path (top-face centroid and area), `mount`, and the edge pads by the export they carry |
| `board/out/board.glb` | Boxes: the substrate, each component (package size where the part states one, else an assumed body: the inductor 2.5 × 2.0 × 1.2 mm, the 0402 resistors 1.0 × 0.5 × 0.35 mm), edge pads, hole rims |
| `board/out/pcb-top.svg`, `pcb-bottom.svg` | Bodies, edge pads, holes and a ratsnest (each net's components joined by straight dashed lines). Not routed. In board millimetres: top (x, −y), bottom seen from below (−x, −y) |
| `board/out/schematic.svg` | Blocks with net labels on the pins, drawn from the UHD nets. Not a provider's schematic |
| `enclosure/out/body.glb` | Boxes and cylinders: `back` and `lid` (named bodies) and thin pads for the three features |
| `enclosure/out/body.manifest.json` | The three features, the volume and each named body's volume |
| `enclosure/out/back.stl`, `lid.stl` | Binary STL of the two bodies (print exports) |
