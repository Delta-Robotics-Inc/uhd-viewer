/**
 * Sample bundles for the viewer's board and enclosure views (PB-823).
 *
 * - `imu-board.bundle.json`: the UHD fixture board (uhd test/fixtures/imu-board.ts)
 *   as the root, with its sample circuit outputs as artifacts.
 * - `uhd-bundle.json`: an "IMU pod": that board mounted in a sample
 *   two-part printed enclosure, with the enclosure's sample cad outputs and
 *   hand-made fit and route findings as producer diagnostics.
 *
 * Both carry a scenario that swaps the IMU's SDx and INT1 pins between their nets,
 * so the I2C link derived over the nets is incomplete (`bus_incomplete`).
 *
 * The board is the UHD fixture unchanged except for what a project adds to a
 * board once it is designed: a mounting-hole interface with its frame, and
 * artifacts pointing at the standard outputs. The enclosure is a sample
 * definition written here. Every output file is hand-made (see
 * fixtures/README.md); none comes from a real provider.
 */
import type { ArtifactDef, InterfaceDef, ModuleDef } from "@uhd/types/index.js";
import type { UhdBundle, UhdBundleDiagnostic } from "@uhd/types/bundle.js";
import { BoltPattern, defineModule } from "@uhd/protocols/index.js";
import { IMU_BOARD, lookupBoardModule } from "../../../uhd/test/fixtures/imu-board";
import { boardOutputs } from "./board-outputs";
import { enclosureOutputs } from "./enclosure-outputs";
import { BOARD, BOARD_IN_ENCLOSURE, CABLE_ENTRY, ENCLOSURE, HOLES, SWD_WINDOW } from "./placement";

const SAMPLE = "Sample output, hand-made for the viewer's fixtures (uhd-viewer fixtures/README.md); not produced by a provider.";

const assumption = (field: string, value: string, reason: string) => ({ type: "assumption", params: { field, value, reason } });

function artifact(id: string, name: string, filePath: string, extra: Partial<ArtifactDef>): ArtifactDef {
  return { id, name, type: "custom", filePath, description: SAMPLE, tags: ["sample"], ...extra };
}

export interface Fixtures {
  board: ModuleDef;
  enclosure: ModuleDef;
  pod: ModuleDef;
  definitions: ModuleDef[];
  files: Record<string, string | Uint8Array>;
  bundles: { pod: UhdBundle; board: UhdBundle };
}

/**
 * The scenario variant: the IMU's SDx (u2 pin 14) and INT1 (u2 pin 4) swapped
 * onto each other's nets, as in UHD's own test of `bus_incomplete`.
 */
export function sdaOnInterrupt(board: ModuleDef): ModuleDef {
  const moved: Record<string, { id: string; net: string }> = {
    "sda.u2.pin_14": { id: "imu_int1.u2.pin_14", net: "imu_int1" },
    "imu_int1.u2.pin_4": { id: "sda.u2.pin_4", net: "sda" },
  };
  return {
    ...board,
    links: (board.links ?? []).map((l) => (moved[l.id] ? { ...l, id: moved[l.id].id, b: { self: true, interfaceId: moved[l.id].net } } : l)),
  };
}

export function buildFixtures(): Fixtures {
  const lookup = lookupBoardModule;
  const out = boardOutputs(IMU_BOARD, lookup);
  const enc = enclosureOutputs();
  const mountSig = out.manifest.features.mount;

  // the board's mounting holes: what a project adds once the board has an outline
  const mount: InterfaceDef = {
    ...BoltPattern({
      id: "mount",
      name: "Mounting holes",
      role: "component",
      shape: "circle",
      spacingMm: HOLES[1][0] - HOLES[0][0],
      holeCount: 2,
      fastener: "M2",
      fastenerDiameterMm: 2,
      threaded: false,
    }),
    geometry: {
      frame: { origin: [...mountSig.centroid], normal: [0, 0, -1], xAxis: [1, 0, 0], symmetryDeg: 180 },
      refs: [{ kind: "feature", artifact: "board_glb", name: "mount", signature: { area_mm2: mountSig.area_mm2, centroid: [...mountSig.centroid] } }],
    },
  };
  const boardBase = "board/out";
  const board: ModuleDef = {
    ...IMU_BOARD,
    id: "sample-imu-board",
    name: "IMU board (fixture + sample outputs)",
    description: `${IMU_BOARD.description} Viewer sample: the UHD fixture board with mounting holes and hand-made standard outputs.`,
    interfaces: [...IMU_BOARD.interfaces, mount],
    domains: [{ domain: "mechanical", dimensions_mm: { length: BOARD.length, width: BOARD.width, height: BOARD.thickness } }],
    artifacts: [
      artifact("board_glb", "Board body (GLB)", `${boardBase}/board.glb`, { type: "3d_model", format: "glb", role: "body", units: "mm" }),
      artifact("board_manifest", "Board geometry manifest", `${boardBase}/board.manifest.json`, { type: "cad", format: "json", provenance: { generatedFrom: "board_glb" } }),
      artifact("bom", "Bill of materials", `${boardBase}/bom.csv`, { type: "documentation", format: "csv", mimeType: "text/csv" }),
      artifact("pnp", "Pick and place", `${boardBase}/pnp.csv`, { type: "pcb", format: "csv", mimeType: "text/csv" }),
      artifact("netlist", "Netlist report", `${boardBase}/netlist.json`, { type: "pcb", format: "json" }),
      artifact("schematic", "Schematic", `${boardBase}/schematic.svg`, { type: "schematic", format: "svg", role: "drawing", mimeType: "image/svg+xml" }),
      artifact("pcb_top", "PCB top", `${boardBase}/pcb-top.svg`, { type: "pcb", format: "svg", role: "drawing", mimeType: "image/svg+xml" }),
      artifact("pcb_bottom", "PCB bottom", `${boardBase}/pcb-bottom.svg`, { type: "pcb", format: "svg", role: "drawing", mimeType: "image/svg+xml" }),
    ],
    traits: [
      ...(IMU_BOARD.traits ?? []),
      assumption("placement", "hand-made", "Component positions, mounting holes and edge pads are chosen by hand for the viewer's fixtures; nothing was laid out or routed."),
    ],
  };

  // ---- the enclosure: the interfaces it must hold, bound to features of its body
  const encBase = "enclosure/out";
  const feature = (name: keyof typeof enc.manifest.features) => {
    const f = enc.manifest.features[name];
    return { kind: "feature" as const, artifact: "enclosure_glb", name, signature: { area_mm2: f.area_mm2, centroid: [...f.centroid] as [number, number, number] } };
  };
  const opening = (id: string, name: string, frame: NonNullable<InterfaceDef["geometry"]>["frame"], note: string): InterfaceDef => ({
    id,
    name,
    domain: "mechanical",
    exposed: true,
    default_active: true,
    protocols: [{ type: "custom", roles: ["opening"] }],
    geometry: { frame, refs: [feature(id)] },
    traits: [{ type: "note", params: { text: note } }],
  });
  const boardMount = BoltPattern({
    id: "board_mount",
    name: "Board bosses",
    role: "structure",
    shape: "circle",
    spacingMm: HOLES[1][0] - HOLES[0][0],
    holeCount: 2,
    fastener: "M2",
    fastenerDiameterMm: 2,
    threaded: true,
    note: "M2 self-tapping screws into printed bosses (sample assumption)",
  });
  const enclosure = defineModule({
    id: "sample-imu-enclosure",
    name: "IMU pod enclosure (sample)",
    description: "Two-part printed enclosure: a back shell with two bosses for the board, and a lid with a window over the SWD pads. Sample definition with hand-made cad outputs.",
    categories: ["enclosure"],
    interfaces: [
      {
        ...boardMount,
        geometry: {
          frame: { origin: [...enc.manifest.features.board_mount.centroid], normal: [0, 0, 1], xAxis: [1, 0, 0], symmetryDeg: 180 },
          refs: [feature("board_mount")],
        },
      },
      opening("cable_entry", "Cable entry", { origin: [0, CABLE_ENTRY.y, CABLE_ENTRY.z], normal: [-1, 0, 0], xAxis: [0, 1, 0] }, "Opening for the battery lead to the VIN and GND pads."),
      opening("swd_window", "SWD window", { origin: [SWD_WINDOW.x, SWD_WINDOW.y, ENCLOSURE.backHeight + ENCLOSURE.lid], normal: [0, 0, 1], xAxis: [1, 0, 0] }, "Window in the lid over the SWD pads, for a pogo-pin adapter."),
    ],
    domains: [
      {
        domain: "mechanical",
        dimensions_mm: { length: ENCLOSURE.length, width: ENCLOSURE.width, height: ENCLOSURE.backHeight + ENCLOSURE.lid },
        material: { name: "PLA", density_g_cm3: 1.24, assumption: "Typical PLA density, assumed for the sample enclosure; no source states it." },
      },
    ],
    artifacts: [
      artifact("enclosure_glb", "Enclosure body (GLB)", `${encBase}/body.glb`, { type: "3d_model", format: "glb", role: "body", units: "mm" }),
      artifact("enclosure_manifest", "Enclosure geometry manifest", `${encBase}/body.manifest.json`, { type: "cad", format: "json", provenance: { generatedFrom: "enclosure_glb" } }),
      artifact("back_stl", "Back shell (print)", `${encBase}/back.stl`, { type: "cad", format: "stl", units: "mm", tags: ["sample", "print"] }),
      artifact("lid_stl", "Lid (print)", `${encBase}/lid.stl`, { type: "cad", format: "stl", units: "mm", tags: ["sample", "print"] }),
    ],
    traits: [
      assumption("geometry", "hand-made", "Wall 1.6 mm, floor 1.6 mm, bosses Ø4 × 3 mm: chosen by hand for the fixture, not generated or checked for printing."),
    ],
  } as ModuleDef);

  const pod = defineModule({
    id: "sample-imu-pod",
    name: "IMU pod (sample)",
    description: "The UHD fixture IMU board in a two-part printed enclosure. Viewer fixture for boards and enclosures (PB-823).",
    interfaces: [],
    children: [
      { id: "board", moduleDefId: board.id, name: "IMU board" },
      { id: "enclosure", moduleDefId: enclosure.id, name: "Enclosure" },
    ],
    links: [{ id: "board_mount", name: "Board on bosses", a: { child: "board", interfaceId: "mount" }, b: { child: "enclosure", interfaceId: "board_mount" } }],
  });

  // the fixture's parts as UHD defines them, without their artifacts: those files live in the UHD part
  // library, which these bundles do not ship (the 3D view draws them inside board.glb)
  const parts = (board.children ?? [])
    .map((c) => lookup(c.moduleDefId)!)
    .filter((d, i, all) => all.indexOf(d) === i)
    .map(({ artifacts, ...def }) => (void artifacts, def as ModuleDef));
  const definitions = [pod, board, enclosure, ...parts];

  // hand-made findings, worked out from the sample geometry, as a cad provider's check would report them
  const swdOffset = Math.round((SWD_WINDOW.x - (9.5 + BOARD_IN_ENCLOSURE[0])) * 10) / 10;
  const lidUnderside = ENCLOSURE.backHeight - BOARD_IN_ENCLOSURE[2] - BOARD.thickness;
  const validator = "sample/cad:check (hand-made)";
  const findings: UhdBundleDiagnostic[] = [
    {
      code: "FIT_OPENING_OFFSET",
      severity: "error",
      entity: { kind: "interface", id: "enclosure:swd_window" },
      message: `swd_window is ${swdOffset} mm off the board's SWD pads along x (allowed 0.3 mm): a pogo-pin adapter will not seat.`,
      validator,
    },
    {
      code: "FIT_HEIGHT_UNSTATED",
      severity: "warning",
      entity: { kind: "instance", id: "board/l1" },
      message: `l1 states no package height; its clearance to the lid (${Math.round((lidUnderside - 1.2) * 10) / 10} mm) assumes the sample's 1.2 mm body.`,
      validator,
    },
    {
      code: "ROUTE_BEND",
      severity: "warning",
      entity: { kind: "interface", id: "board:power_in" },
      message: "The battery lead runs 3 mm from cable_entry to the VIN pad and turns down 0.3 mm onto it: tighter than a 26 AWG lead's 2 mm bend radius.",
      validator,
    },
  ];

  const scenario = (root?: ModuleDef) => ({
    id: "imu-sdx-int1-swapped",
    label: "IMU SDx and INT1 swapped",
    description: "The IMU's SDx (u2 pin 14) is on the IMU_INT1 net and its INT1 (pin 4) on SDA: the I2C bus between the MCU and the IMU is incomplete.",
    ...(root ? { root } : { definitions: [sdaOnInterrupt(board)] }),
  });

  const files: Record<string, string | Uint8Array> = {};
  for (const [name, content] of Object.entries(out.files)) files[`${boardBase}/${name}`] = content;
  for (const [name, content] of Object.entries(enc.files)) files[`${encBase}/${name}`] = content;

  const meta = (name: string) => ({ name, producer: "uhd-viewer fixtures (hand-made samples)" });
  const podBundle: UhdBundle = {
    schema: "uhd.bundle/v0",
    root: pod.id,
    definitions,
    scenarios: [scenario()],
    diagnostics: findings,
    meta: meta("IMU pod (sample)"),
  };
  const boardBundle: UhdBundle = {
    schema: "uhd.bundle/v0",
    root: board.id,
    definitions: [board, ...parts],
    scenarios: [scenario(sdaOnInterrupt(board))],
    meta: meta("IMU board (sample)"),
  };
  files["uhd-bundle.json"] = JSON.stringify(podBundle, null, 1) + "\n";
  files["imu-board.bundle.json"] = JSON.stringify(boardBundle, null, 1) + "\n";
  return { board, enclosure, pod, definitions, files, bundles: { pod: podBundle, board: boardBundle } };
}
