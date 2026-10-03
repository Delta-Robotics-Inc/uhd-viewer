import { describe, expect, it } from "vitest";
import { buildView } from "../src/model/from-uhd";
import { tapRails, RAIL_TAP_MIN } from "../src/layout/taps";
import { boardClusters } from "../src/layout/board-layout";
import { computeLayout } from "../src/layout/layout";
import { IMU_BOARD, lookupBoardModule } from "../../uhd/test/fixtures/imu-board";

const view = () => buildView(IMU_BOARD, lookupBoardModule, [], { expanded: new Set() });

describe("rail taps (a supply rail drawn beside each part it feeds)", () => {
  it("splits a rail with many members into one tap per cluster, the largest keeping the net's id", () => {
    const vm = view();
    const rail = vm.nodes.find((n) => n.id === ":v3v3")!;
    expect(rail.ports.length).toBeGreaterThanOrEqual(RAIL_TAP_MIN);
    const drawn = tapRails(vm);
    const taps = drawn.nodes.filter((n) => n.id === ":v3v3" || n.tapOf === ":v3v3");
    expect(taps.length).toBeGreaterThan(1);
    expect(taps[0].id).toBe(":v3v3");
    expect(taps[0].tapOf).toBeUndefined();
    for (const t of taps.slice(1)) {
      expect(t.id.startsWith(":v3v3~")).toBe(true);
      expect(t).toMatchObject({ label: rail.label, net: rail.net, kind: "net" });
    }
    // every member's line ends at exactly one tap, on its own port there
    const lines = drawn.links.filter((l) => l.net?.id === "v3v3");
    expect(lines.map((l) => l.id).sort()).toEqual(vm.links.filter((l) => l.net?.id === "v3v3").map((l) => l.id).sort());
    for (const l of lines) {
      const tap = taps.find((t) => t.id === l.target.node)!;
      expect(tap, l.id).toBeDefined();
      expect(tap.ports.some((p) => p.id === l.target.port)).toBe(true);
    }
    // the ports are shared out, none lost or doubled
    expect(taps.flatMap((t) => t.ports.map((p) => p.id)).sort()).toEqual(rail.ports.map((p) => p.id).sort());
  });

  it("joins each tap only to the members of one cluster (a part and the passives that serve it)", () => {
    const vm = view();
    const drawn = tapRails(vm);
    const top = vm.nodes.filter((n) => !n.parent && !n.sheetPort);
    const { clusterOf } = boardClusters(
      top.map((n) => ({ id: n.id, w: 0, h: 0, net: n.kind === "net", category: n.category, label: n.label })),
      vm.links.filter((l) => !l.passThrough && !l.ground).map((l) => [l.source.node, l.target.node]),
    );
    for (const tap of drawn.nodes.filter((n) => n.id === ":v3v3" || n.tapOf === ":v3v3")) {
      const members = drawn.links.filter((l) => l.target.node === tap.id).map((l) => clusterOf.get(l.source.node));
      expect(new Set(members).size, tap.id).toBe(1);
    }
  });

  it("leaves signal nets and small rails as one junction, and the view model it was given untouched", () => {
    const vm = view();
    const before = JSON.stringify(vm);
    const drawn = tapRails(vm);
    expect(JSON.stringify(vm)).toBe(before);
    for (const id of [":sda", ":scl", ":imu_int1", ":fb"]) {
      expect(drawn.nodes.filter((n) => n.id === id || n.tapOf === id)).toHaveLength(1);
    }
  });

  it("lays the taps out like any junction: nothing overlaps and every line is routed", () => {
    const drawn = tapRails(view());
    const layout = computeLayout(drawn, undefined, {}, false);
    const top = drawn.nodes.filter((n) => !n.parent);
    for (let i = 0; i < top.length; i++)
      for (let j = i + 1; j < top.length; j++) {
        const a = layout.boxes[top[i].id];
        const b = layout.boxes[top[j].id];
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h, `${top[i].id} / ${top[j].id}`).toBe(false);
      }
    for (const l of drawn.links.filter((l) => !l.ground)) expect(layout.routes[l.id], l.id).toBeDefined();
  });
});
