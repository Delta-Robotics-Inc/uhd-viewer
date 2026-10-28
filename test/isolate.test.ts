/**
 * Isolating a legend entry (PB-946): what stays on a level when a signal
 * type, a domain or a DRC state is isolated, on the IMU pod fixture (a board
 * with nets and rails, in an enclosure) at the top level, inside the board,
 * and with the board expanded in place.
 */
import { describe, expect, it } from "vitest";
import type { ModuleDef } from "@uhd/types/index.js";
import { buildView } from "../src/model/from-uhd";
import { systemDiagnostics } from "../src/model/diagnostics";
import { tapRails } from "../src/layout/taps";
import { classKey, legendFor, type Classification } from "../src/model/classification";
import { isolate, linkKeys, presentKeys, toggleIsolated } from "../src/model/isolate";
import { hostSelection } from "../src/host/targets";
import bundle from "../fixtures/imu-pod/uhd-bundle.json";

const defs = new Map((bundle.definitions as unknown as ModuleDef[]).map((d) => [d.id, d]));
const lookup = (id: string) => defs.get(id);
const root = defs.get(bundle.root)!;
const view = (drill: string[], expanded: string[] = []) =>
  tapRails(buildView(root, lookup, drill, { expanded: new Set(expanded), diagnostics: systemDiagnostics(root, lookup) }));

const MODES: Classification[] = ["signal", "domain", "drc"];
const LEVELS: [string, string[], string[]][] = [
  ["the top level", [], []],
  ["inside the board", ["board"], []],
  ["the board expanded in place", [], ["board"]],
];

describe("legend entries", () => {
  it("gives every colour group one key, shared by the protocols that share a colour", () => {
    expect(classKey({ domain: "electrical", protocol: "crsf" }, "signal")).toBe("uart");
    expect(classKey({ domain: "electrical", protocol: "uart_tx" }, "signal")).toBe("uart");
    expect(classKey({ domain: "electrical", protocol: "bldc_phase" }, "signal")).toBe("phase");
    expect(classKey({ domain: "electrical", protocol: "ethernet" }, "signal")).toBe("other");
    expect(classKey({ domain: "mechanical", protocol: "bolt_pattern" }, "signal")).toBe("other-domains");
    expect(classKey({ domain: "mechanical", protocol: "bolt_pattern" }, "domain")).toBe("mechanical");
    expect(classKey({ domain: "optical", protocol: "fibre" }, "domain")).toBe("other");
    expect(classKey({ domain: "electrical", protocol: "i2c", state: "partial" }, "drc")).toBe("partial");
    expect(classKey({ domain: "electrical", protocol: "i2c" }, "drc")).toBe("unconfigured");
  });

  it("lists the fixed entries, and the others only where the level has them", () => {
    for (const mode of MODES) {
      const keys = legendFor(mode).map((e) => e.key);
      expect(new Set(keys).size, mode).toBe(keys.length);
    }
    expect(legendFor("signal").map((e) => e.key)).not.toContain("spi");
    const withSpi = legendFor("signal", new Set(["spi", "power"])).map((e) => e.key);
    expect(withSpi).toContain("spi");
    expect(withSpi[withSpi.length - 1]).toBe("other-domains");
    expect(legendFor("domain", new Set(["software"])).map((e) => e.key)).toContain("software");
  });

  it("has an entry for everything drawn on a level, in every classification", () => {
    for (const [name, drill, expanded] of LEVELS) {
      const vm = view(drill, expanded);
      for (const mode of MODES) {
        const present = presentKeys(vm, mode);
        const legend = new Set(legendFor(mode, present).map((e) => e.key));
        for (const k of present) expect(legend.has(k), `${name}, ${mode}: ${k}`).toBe(true);
      }
    }
  });
});

describe("isolate", () => {
  it("isolates nothing when no entry is held", () => {
    expect(isolate(view([]), "signal", new Set())).toBeNull();
  });

  for (const [name, drill, expanded] of LEVELS) {
    for (const mode of MODES) {
      it(`keeps the links of each entry, their ends and what holds them: ${name}, by ${mode}`, () => {
        const vm = view(drill, expanded);
        const present = presentKeys(vm, mode);
        expect(present.size).toBeGreaterThan(0);
        for (const key of present) {
          const iso = isolate(vm, mode, new Set([key]))!;
          // exactly the links of that entry
          const want = vm.links.filter((l) => linkKeys(l, mode).has(key)).map((l) => l.id).sort();
          expect([...iso.links].sort(), key).toEqual(want);
          // both ends of every link that stays, and the ports they end on
          for (const l of vm.links.filter((x) => iso.links.has(x.id))) {
            for (const end of [l.source, l.target]) {
              // a ground return drawn as symbols ends on a net with no junction on the level
              if (!vm.nodes.some((n) => n.id === end.node)) continue;
              expect(iso.nodes.has(end.node), `${key}: ${end.node}`).toBe(true);
              expect(iso.ports.has(`${end.node}|${end.port}`), `${key}: ${end.node}|${end.port}`).toBe(true);
            }
          }
          // a node that stays: an end of such a link, a net of that kind (or a tap of one), or something that holds one
          for (const id of iso.nodes) {
            const node = vm.nodes.find((n) => n.id === id)!;
            expect(node, id).toBeDefined();
            const touched = vm.links.some((l) => iso.links.has(l.id) && (l.source.node === id || l.target.node === id));
            const ownNet = !!node.net && classKey({ domain: "electrical", protocol: node.net.signal, state: node.status }, mode) === key;
            const holds = vm.nodes.some((n) => n.parent === id && iso.nodes.has(n.id));
            expect(touched || ownNet || holds, `${key}: ${id}`).toBe(true);
          }
          // every port that stays is on a node that stays
          for (const p of iso.ports) if (vm.nodes.some((n) => n.id === p.split("|")[0])) expect(iso.nodes.has(p.split("|")[0]), p).toBe(true);
        }
      });
    }
  }

  it("fades the rest: a level with several entries never keeps everything for one of them", () => {
    const vm = view(["board"]);
    const present = presentKeys(vm, "signal");
    expect(present.size).toBeGreaterThan(1);
    expect(present.has("power")).toBe(true);
    const iso = isolate(vm, "signal", new Set(["power"]))!;
    expect(iso.links.size).toBeGreaterThan(0);
    expect(iso.links.size).toBeLessThan(vm.links.length);
    expect(iso.nodes.size).toBeLessThan(vm.nodes.length);
    // the power rails stay, drawn as taps or not; a ground net does not
    const rails = vm.nodes.filter((n) => n.net?.signal === "power");
    expect(rails.length).toBeGreaterThan(0);
    for (const r of rails) expect(iso.nodes.has(r.id), r.id).toBe(true);
    for (const g of vm.nodes.filter((n) => n.net?.ground)) expect(iso.nodes.has(g.id), g.id).toBe(false);
  });

  it("holds several entries: the union of what each keeps", () => {
    const vm = view(["board"]);
    const [a, b] = [...presentKeys(vm, "signal")];
    const one = isolate(vm, "signal", new Set([a]))!;
    const other = isolate(vm, "signal", new Set([b]))!;
    const both = isolate(vm, "signal", new Set([a, b]))!;
    expect([...both.links].sort()).toEqual([...new Set([...one.links, ...other.links])].sort());
    for (const n of [...one.nodes, ...other.nodes]) expect(both.nodes.has(n)).toBe(true);
  });

  it("keeps the module expanded in place that holds what stays", () => {
    const vm = view([], ["board"]);
    const inside = vm.links.find((l) => l.source.node.startsWith("board/") || l.target.node.startsWith("board/"))!;
    expect(inside).toBeDefined();
    const [key] = linkKeys(inside, "signal");
    const iso = isolate(vm, "signal", new Set([key]))!;
    expect(iso.nodes.has("board")).toBe(true);
  });

  it("follows the model as it rebuilds: the same keys on a rebuilt level give the same result", () => {
    const keys = new Set(["power"]);
    const before = isolate(view(["board"]), "signal", keys)!;
    const after = isolate(view(["board"]), "signal", keys)!;
    expect([...after.links].sort()).toEqual([...before.links].sort());
    expect([...after.nodes].sort()).toEqual([...before.nodes].sort());
    // an entry the rebuilt level no longer has keeps nothing, and breaks nothing
    const gone = isolate(view([]), "signal", new Set(["can"]))!;
    expect(gone.links.size + gone.nodes.size + gone.ports.size).toBe(0);
  });

  it("is not a selection: the host hears nothing of it", () => {
    const vm = view(["board"]);
    expect(hostSelection(vm, ["board"], null, "x")).toBeNull();
    expect(isolate(vm, "signal", new Set(["power"]))).not.toBeNull();
  });
});

describe("toggleIsolated (a click on a legend entry)", () => {
  it("isolates the entry, switches to another, and shows everything on a second click", () => {
    let held: ReadonlySet<string> = new Set<string>();
    held = toggleIsolated(held, "power");
    expect([...held]).toEqual(["power"]);
    held = toggleIsolated(held, "uart");
    expect([...held]).toEqual(["uart"]);
    held = toggleIsolated(held, "uart");
    expect(held.size).toBe(0);
  });

  it("holds several with a modifier, and a plain click on one of several keeps only it", () => {
    let held: ReadonlySet<string> = toggleIsolated(new Set(), "power");
    held = toggleIsolated(held, "uart", true);
    expect([...held].sort()).toEqual(["power", "uart"]);
    held = toggleIsolated(held, "power", true);
    expect([...held]).toEqual(["uart"]);
    held = toggleIsolated(new Set(["power", "uart"]), "power");
    expect([...held]).toEqual(["power"]);
  });
});

describe("the legend's entries read as a name and what it stands for", () => {
  const all = (mode: Classification) => legendFor(mode, new Set(["spi", "analog", "digital", "can", "other", "software"]));
  it.each(["domain", "drc", "signal"] as const)("%s: every entry has a short meaning, and a name in title case", (mode) => {
    for (const e of all(mode)) {
      expect(e.meaning.length, `${e.key}: ${e.meaning}`).toBeGreaterThan(2);
      // a few words, no sentence: it is the second line of a 230 px card
      expect(e.meaning.length, `${e.key}: ${e.meaning}`).toBeLessThanOrEqual(24);
      expect(e.meaning).not.toMatch(/\.$/);
      // not shouting: the name's first letter is a capital and it is not all capitals (acronyms aside)
      expect(e.label[0]).toBe(e.label[0].toUpperCase());
      if (e.label.length > 4 && !/\//.test(e.label)) expect(e.label, e.key).not.toBe(e.label.toUpperCase());
    }
  });
});
