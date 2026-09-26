# UHD model support for the viewer design

Reviewed against `Delta-Robotics-Inc/uhd` `origin/main` at `a315fbc`
(2026-09-26). Note that the local `main` checkout is 10 commits behind it.

Each sample board in `uhd-viewer-design.pen` has a note beside it with the same
verdict. The statuses mean:

- **Supported:** the model already represents it.
- **Partial:** representable with workarounds or missing pieces.
- **Gap:** needs a model change.
- **Viewer:** layout data owned by the viewer, not UHD.

## Update — 2026-09-26 (UHD branch `mark/pb-782-quadcopter-system`)

The quick wins below are implemented in UHD. The per-sample table keeps the
original verdicts for reference; current status:

| Board · sample | Was | Now | How |
| --- | --- | --- | --- |
| 01 · 1:1 link, no harness | Gap | **Supported** | `ModuleDef.links: InterfaceLink[]` with explicit `EndpointTarget` (`self` \| `child`) |
| 02 · collapsed → opened | Partial | **Supported** | `validateLink` returns per-child links (slot → leaf, pin) for each stored link |
| 02 · remap child links | Gap | **Supported (model)** | `InterfaceLink.childLinks` override derived ones; viewer editing not built yet |
| 02 · unmapped child | Partial | Partial | `unresolvedSlots` per link; sub-links still have no state of their own |
| 04 · harness topologies | Partial | Partial | Endpoint `role` (source/drop/trunk/alt), harness parameters/artifacts/traits; `kind: "harness"` exists but harness DRC does not |
| 06 · DRC health | Partial | **Supported per link** | `validateLinks` (pair DRC on sliced modules); capacity and bus DRC still missing |
| 07 · group exporting children | Gap | **Supported** | `kind: "group"` exports every child interface not linked internally |
| 07 · real module with own interfaces | Partial | **Supported** | `exports` + `links` with `self` endpoints; `resolveEndpoint` follows exports |
| 07 · drill with breadcrumb | Partial | **Supported** | Canonical paths (`formatPath`/`parsePath`); viewer drills by child id |
| 05 · ports grouped by type | Gap | Partial | `display.visibleInterfaces` hint added; grouping still uses the free-form protocol type |

## Per sample

| Board · sample | Status | Evidence and needed change |
| --- | --- | --- |
| 01 · 1:1 link, no harness | Gap | No stored link record. Top-level connections exist only as derived `ConnectionResult` (`src/drc/types.ts:90-106`, id computed in `validate-pair.ts:199`); inside a module the only stored connection is `HarnessDef` (`src/types/harness.ts:13-19`). Add `InterfaceLink`. |
| 01 · label slots and waypoints | Viewer | Stored in the viewer layout document, keyed by canonical path. Needs stable paths (see 07). |
| 02 · collapsed → opened I2C | Partial | Slots/profiles compose I2C from pin interfaces (`src/types/interface.ts:11-35`), and the region tree gives the nesting (`src/drc/region-tree.ts:36-77`). Child links are derived by `resolveSubLinks` (`validate-pair.ts:245-325`) but not stored, and only between two flat modules. |
| 02 · remap child links (phase swap) | Gap | `ManualLinkDef` (`drc/types.ts:153-158`) is accepted as an option but never read by `validatePair`. Capability-only slots (NEO Vortex phase dock) never pair (`validate-pair.ts:279` requires `match.protocol`). Add stored `childLinks`. |
| 02 · crossover and unmapped child | Partial | `unresolvedSlots` and sub-link diagnostics exist; a sub-link has no `state` of its own. |
| 03 · bundled vs conductors | Partial | Conductors come from slots. The motor-phase builder is missing (PB-780). Detail level is a viewer preference. |
| 04 · point-to-point cable | Partial | `topology: "wire"` exists. A harness has no ports, parameters, artifacts, geometry, or traits. |
| 04 · bus | Partial | `topology: "bus"` with N endpoints (robot-car `sensor_bus`). No trunk/drop roles; DRC hard-codes `"wire"` (`validate-pair.ts:227`); `drops` is never filled. |
| 04 · split/splice | Partial | `topology: "split"` exists. No source/drop roles and no harness parameters (gauge, current). |
| 04 · OR/switch | Partial | `topology: "or"` plus `HarnessInstanceState.selectedEndpointId` (`src/types/instance.ts:31`), which nothing reads. |
| 05 · show all ports | Partial | Domain and name are on every interface. Outline position isn't modelled; `NodeGeometry` (`src/types/module.ts:31-37`) is unused by renderers. |
| 05 · grouped by type | Gap | No default-visible set, grouping, or order. `protocols[].type` is a free string with no registry. |
| 05 · size and shape | Partial | `NodeGeometry {xScale, yScale, outline.preset}` exists and is set in one fixture only. There are no custom outlines. |
| 06 · domain classification | Supported | `domain` is required on `InterfaceDef` and `HarnessDef`; `DomainKind` in `src/types/domain.ts:1-8`. |
| 06 · DRC health | Partial | Per pair connection only (`ConnectionState`, 7 values). No per-link, per-harness, or per-sub-link state in a system; `capacity` is always `[]`. |
| 06 · electrical signal type | Partial | Needs a canonical protocol-type registry. |
| 07 · group exporting children | Gap | `InterfaceDef.exposed` is only a filter; `ChildModuleRef.exposedInterfaces` (`module.ts:11`) is never read. Add `exports` and a group kind. |
| 07 · real module with own interfaces | Partial | A harness endpoint without `childModuleId` implicitly means the parent (robot-car `main_power`). Instance bindings require `childModuleId` (`instance.ts:26`); internal harnesses aren't evaluated; `instantiateModule` never builds `childInstances` (`src/instance/instantiate.ts:68`). |
| 07 · drill with breadcrumb | Partial | The definition hierarchy exists. There is no canonical cross-hierarchy path; instance ids are random UUIDs. |
| 08 · pair view | Supported | `validatePair` → `PairValidationResult` already drives protoboard.ai/validate. |

## Recommended UHD changes

These are to be picked up after the design is locked, under PB-778 (JSON form)
and PB-782 (system DRC), or in a dedicated issue.

1. **Exports.** Add `ModuleDef.exports: {id, from: {child, interfaceId, profileInstanceId?}}[]`
   to promote a child interface to the parent boundary. Add `kind: "group"`,
   meaning "export every child's exposed interfaces". Retire or reinterpret
   `ChildModuleRef.exposedInterfaces`.
2. **Explicit endpoint targets.** `{self: true, interfaceId} | {child, interfaceId, profileInstanceId?}`,
   used identically in definitions and instances.
3. **Interface links.** `InterfaceLink {id, a, b, childLinks?: {a, b, locked}[]}`
   on `ModuleDef.links`, for harness-less links. Stored child links override
   derived ones.
4. **Harness as a module kind.** `kind: "harness"` with `topology` and N `ports`
   with roles (`trunk | drop | source | alt`), inheriting parameters, artifacts,
   and geometry, and carrying its own links. OR-selection is instance state.
5. **Module-scope DRC.** `validateModule(def)` evaluates links and harnesses and
   emits per-link, per-harness, and per-sub-link state keyed by canonical path.
6. **Canonical paths.** `child(/child)*:interface(#profileInstance)(/slot)`, used
   for layout, selection, links, and diagnostics.
7. **Protocol-type registry.** A canonical list of protocol types (generated from
   `src/protocols`) for grouping ports and colouring by signal type.
8. **Display hints.** An optional `display` block on `ModuleDef` (visible
   interfaces, grouping, default side/order, shape preset). Per-project overrides
   stay in the viewer layout document.
