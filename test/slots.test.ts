/**
 * The inspector's interface slot cards (PB-1042, design A with expandable
 * cards): each interface's kind, protocol, role and pins, what it is linked
 * to, and for an expanded card its pin mapping (a receiver's TX on the
 * flight controller's RX2), its parameters with units, its links and their
 * state, its findings, its notes and assumptions; the sections' keyboard
 * moves; and the cards rendered, closed and expanded.
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { ModuleDef } from "@uhd/types/index.js";
import { buildView } from "../src/model/from-uhd";
import { checkFindings, direction, groupSlots, humanize, interfaceSlots, levelNames, paramValue, slotSummary, type InterfaceSlot } from "../src/model/slots";
import { ClampedText, DetailsSection, SelectionKey, Sections, keptInspectorState, navTarget } from "../src/chrome/Sections";
import { InterfaceCards } from "../src/chrome/InterfaceCards";

const leaf = (id: string, pin: string, type: string, role: string, extra: Record<string, unknown> = {}) => ({ id, name: pin, pin, domain: "electrical", exposed: true, protocols: [{ type, roles: [role] }], ...extra });

const fc = {
  id: "fc",
  name: "Flight controller",
  interfaces: [
    leaf("uart2_rx", "RX2", "uart", "receiver"),
    leaf("uart2_tx", "TX2", "uart", "transmitter"),
    leaf("bec_5v", "5V", "power", "output", { parameters: [{ id: "voltage", unit: "V", value: 5 }, { id: "max_current", unit: "A", value: 3 }] }),
    leaf("gnd", "GND", "power", "ground"),
    { id: "usb", name: "USB-C", domain: "electrical", exposed: true, protocols: [{ type: "usb", roles: ["device"] }], traits: [{ type: "usage_note", params: { note: "Configuration and DFU flashing.", source: "https://example.com/fc-manual.pdf" } }] },
    { id: "mount", name: "Stack mount", domain: "mechanical", exposed: true, protocols: [{ type: "bolt_pattern", roles: ["component"] }] },
  ],
} as unknown as ModuleDef;

const receiver = {
  id: "rx",
  name: "ELRS receiver",
  interfaces: [
    leaf("crsf_tx", "TX", "uart", "transmitter"),
    leaf("crsf_rx", "RX", "uart", "receiver"),
    leaf("vcc_5v", "5V", "power", "input", { traits: [{ type: "assumption", params: { field: "current draw", reason: "Not stated; under 100 mA." } }] }),
    leaf("gnd", "G", "power", "ground"),
  ],
} as unknown as ModuleDef;

const quad = {
  id: "quad",
  name: "Quad",
  interfaces: [],
  children: [
    { id: "stack", moduleDefId: "fc", name: "FC stack" },
    { id: "receiver", moduleDefId: "rx", name: "ELRS receiver" },
  ],
  links: [
    {
      id: "rx_pads",
      name: "Receiver pads",
      a: { child: "receiver", interfaceId: "rx_pads", compose: { p1: "crsf_tx", p2: "crsf_rx", p3: "vcc_5v", p4: "gnd" } },
      b: { child: "stack", interfaceId: "rx_fc_pads", compose: { p1: "uart2_rx", p2: "uart2_tx", p3: "bec_5v", p4: "gnd" } },
    },
  ],
} as unknown as ModuleDef;

const defs = new Map([quad, fc, receiver].map((d) => [d.id, d]));
const lookup = (id: string) => defs.get(id);
const vm = buildView(quad, lookup, [], { expanded: new Set() });
const stack = vm.nodes.find((n) => n.id === "stack")!;
const named = levelNames(vm, quad, lookup);
const findings = checkFindings([{ id: "budget", rule: "supply_budget", severity: "info", message: "5 V BEC: 2% used", refs: ["stack:bec_5v", "link:rx_pads"] }]);
const slots = interfaceSlots(stack, vm, { lookup, ...named, findings });
const slot = (id: string) => slots.find((s) => s.id === id)!;

describe("interface slots", () => {
  it("the receiver pads: a signal slot linked to the receiver, its pins, and the open USB slot", () => {
    const pads = slot("rx_fc_pads");
    expect(pads).toMatchObject({ name: "RX FC pads", kind: "signal", protocol: "UART", pins: ["RX2", "TX2", "5V", "GND"], linked: [{ module: "ELRS receiver" }], open: false });
    expect(slot("usb")).toMatchObject({ kind: "signal", protocol: "USB", role: "device", open: true, linked: [] });
    expect(slot("mount")).toMatchObject({ kind: "mechanical", open: true });
    // linked first, then the open slots
    expect(slots[0].id).toBe("rx_fc_pads");
    expect(slotSummary(slots).text).toBe("1 linked · 2 open");
  });

  it("an exported pad inside a linked pad group is in use through it, not open", () => {
    // the UART leaves are bound by the pad group: they are not slots waiting for a link
    expect(slot("uart2_rx")).toMatchObject({ open: false, usedBy: "RX FC pads" });
    expect(slot("bec_5v")).toMatchObject({ kind: "power", protocol: "Power out", role: "source", open: false });
  });

  it("the pin mapping: each pin, the leaf it binds, and the pin it meets on the receiver", () => {
    expect(slot("rx_fc_pads").pinMap).toEqual([
      { pin: "RX2", leaf: "uart2_rx", dir: "←", other: "TX", otherModule: "ELRS receiver" },
      { pin: "TX2", leaf: "uart2_tx", dir: "→", other: "RX", otherModule: "ELRS receiver" },
      { pin: "5V", leaf: "bec_5v", dir: "→", other: "5V", otherModule: "ELRS receiver" },
      { pin: "GND", leaf: "gnd", dir: "—", other: "G", otherModule: "ELRS receiver" },
    ]);
  });

  it("parameters with their units, named by the pin in a pad group", () => {
    expect(slot("rx_fc_pads").params).toEqual([
      { label: "5V voltage", value: "5 V" },
      { label: "5V max current", value: "3 A" },
    ]);
    expect(paramValue({ unit: "V", range: [6, 30] })).toBe("6–30 V");
    expect(paramValue({ unit: "dimensionless", range: [2, 6] })).toBe("2–6");
    expect(paramValue({ unit: "A" })).toBeUndefined();
  });

  it("its link by id, its state, and the findings on the interface or the link", () => {
    const pads = slot("rx_fc_pads");
    expect(pads.links[0]).toMatchObject({ label: "rx_pads", name: "Receiver pads", select: "rx_pads", via: "to ELRS receiver" });
    expect(pads.links[0].derived).toBeUndefined();
    expect(["configured", "warning", "incompatible", "unconfigured"]).toContain(pads.links[0].state);
    expect(pads.findings).toEqual([{ key: "budget", code: "UHD_SUPPLY_BUDGET", message: "5 V BEC: 2% used", severity: "info" }]);
    expect(slot("usb").findings).toEqual([]);
  });

  it("notes and assumptions: its own traits and its leaves' assumptions, and the sources it cites", () => {
    expect(slot("usb").notes).toEqual([{ label: "Usage note", text: "Configuration and DFU flashing." }]);
    expect(slot("usb").sources).toEqual([{ label: "example.com · fc-manual.pdf", url: "https://example.com/fc-manual.pdf" }]);
  });

  it("which way a pin faces, from its leaf's role, else its name", () => {
    expect(direction(undefined, "RX2")).toBe("←");
    expect(direction(undefined, "TX1")).toBe("→");
    expect(direction(undefined, "GND")).toBe("—");
    expect(direction(undefined, "SDA")).toBe("↔");
    expect(humanize("rx_fc_pads")).toBe("RX FC pads");
    expect(humanize("max_current")).toBe("Max current");
  });
});

describe("inside a module", () => {
  it("an interface the module exports is reached from outside: not an open slot", () => {
    const pack = { id: "pack", name: "FC stack", kind: "module", interfaces: [], children: [{ id: "fc", moduleDefId: "fc", name: "Flight controller" }], exports: [{ id: "bec_5v", name: "5V BEC", from: { child: "fc", interfaceId: "bec_5v" } }] } as unknown as ModuleDef;
    const top = { id: "top", name: "Top", interfaces: [], children: [{ id: "stack", moduleDefId: "pack" }] } as unknown as ModuleDef;
    const all = new Map([top, pack, fc].map((d) => [d.id, d]));
    const find = (id: string) => all.get(id);
    const inside = buildView(top, find, ["stack"], { expanded: new Set() });

    const fcSlots = interfaceSlots(inside.nodes.find((n) => n.id === "fc")!, inside, { lookup: find, drill: ["stack"] });
    expect(fcSlots.find((x) => x.id === "bec_5v")).toMatchObject({ open: false, exportedAs: "5V BEC" });
    expect(fcSlots.find((x) => x.id === "usb")).toMatchObject({ open: true });
  });
});

describe("alike interfaces", () => {
  it("three or more that differ only by a number are one card: Motor pads ×4, every member's pins and links", () => {
    const motor = (i: number): InterfaceSlot => ({ ...slot("rx_fc_pads"), id: `motor_${i}_pads`, name: `Motor ${i} pads`, kind: "power", protocol: "3-phase", pins: [`M${i}`], linked: [{ module: `${["Front-right", "Rear-right", "Rear-left", "Front-left"][i - 1]} arm`, via: `Motor ${i} leads` }], links: [{ label: `m${i}_pads`, select: `m${i}_leads`, state: "configured", diagnostics: [] }], refs: [`m${i}_leads`] });
    const grouped = groupSlots([slot("usb"), motor(2), motor(1), motor(3), motor(4), slot("mount")]);
    expect(grouped.map((s) => s.name)).toEqual(["USB-C", "Motor pads ×4", "Stack mount"]);
    const g = grouped[1];
    expect(g).toMatchObject({ id: "group:motor_#_pads", pins: ["M1", "M2", "M3", "M4"], members: ["motor_1_pads", "motor_2_pads", "motor_3_pads", "motor_4_pads"] });
    expect(g.links.map((l) => l.label)).toEqual(["m1_pads", "m2_pads", "m3_pads", "m4_pads"]);
    expect(g.linked).toHaveLength(4);
    expect(g.together).toEqual({ module: "4 arms", via: "Motor leads" });
    // the header counts interfaces, not cards
    expect(slotSummary(grouped)).toMatchObject({ total: 6, linked: 4, open: 2 });
    // two are not a group
    expect(groupSlots([motor(1), motor(2)]).map((s) => s.name)).toEqual(["Motor 1 pads", "Motor 2 pads"]);
  });
});

describe("the sections' keyboard", () => {
  it("Arrow Up and Down move one stop, Home and End to the ends, other keys do nothing", () => {
    expect(navTarget("ArrowDown", 0, 3)).toBe(1);
    expect(navTarget("ArrowDown", 2, 3)).toBe(2);
    expect(navTarget("ArrowUp", 0, 3)).toBe(0);
    expect(navTarget("ArrowUp", 2, 3)).toBe(1);
    expect(navTarget("Home", 2, 3)).toBe(0);
    expect(navTarget("End", 0, 3)).toBe(2);
    expect(navTarget("Enter", 0, 3)).toBeUndefined();
    expect(navTarget(" ", 0, 3)).toBeUndefined();
    expect(navTarget("ArrowDown", 0, 0)).toBeUndefined();
  });
});

describe("rendered", () => {
  afterEach(() => keptInspectorState.clear());
  const render = (el: ReactElement, selection = "node:stack") => renderToStaticMarkup(createElement(SelectionKey.Provider, { value: selection }, el));
  const cards = (s: InterfaceSlot[] = slots) => createElement(Sections, null, createElement(InterfaceCards, { slots: s, actions: { locate: () => undefined, openSource: () => undefined, connect: () => undefined } }));

  it("closed cards: a disclosure button each, collapsed, with the summary and no details", () => {
    const html = render(cards());
    expect(html).toContain('data-slot="rx_fc_pads"');
    expect(html).toMatch(/data-card-toggle="" aria-expanded="false"/);
    expect(html).not.toContain("data-card-detail");
    expect(html).toContain("ELRS receiver");
    // the open slot says so and offers Connect…
    expect(html).toContain("Open slot");
    expect(html).toContain("Connect…");
  });

  it("an expanded card: aria-expanded, the pin mapping, parameters, links, findings, notes and actions", () => {
    keptInspectorState.setExpanded("node:stack", new Set(["rx_fc_pads", "usb"]));
    const html = render(cards());
    // several open at once
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(2);
    expect(html.match(/data-card-detail=""/g)).toHaveLength(2);
    for (const t of ["Pin mapping", "Protocol and parameters", "Links", "Findings", "Locate on canvas", "Open in source", "UHD_SUPPLY_BUDGET", "5V max current", "3 A"]) expect(html).toContain(t);
    expect(html).toContain('data-pin="RX2"');
    expect(html).toMatch(/data-pin="RX2".*←.*TX.*ELRS receiver/s);
    // the open slot's expanded card: no findings, its note, Connect… among its actions
    expect(html).toContain("No findings for this interface or its links");
    expect(html).toContain("Configuration and DFU flashing.");
  });

  it("the expanded set is kept per selection: another module's cards start closed", () => {
    keptInspectorState.setExpanded("node:stack", new Set(["rx_fc_pads"]));
    expect(render(cards(), "node:stack")).toContain('aria-expanded="true"');
    expect(render(cards(), "node:other")).not.toContain('aria-expanded="true"');
  });

  it("an assumption is marked as such", () => {
    const rx = vm.nodes.find((n) => n.id === "receiver")!;
    const rxSlots = interfaceSlots(rx, vm, { lookup, ...named });
    const pads = rxSlots.find((s) => s.id === "rx_pads")!;
    expect(pads.notes).toEqual([{ label: "Assumption", text: "current draw: Not stated; under 100 mA.", assumption: true }]);
    keptInspectorState.setExpanded("node:receiver", new Set(["rx_pads"]));
    expect(render(cards(rxSlots), "node:receiver")).toContain('data-note="assumption"');
  });

  it("a section: a heading with a disclosure button, its count and summary; closed by default when secondary", () => {
    const open = render(createElement(DetailsSection, { id: "interfaces", title: "Interfaces", count: 7, summary: "6 linked · 1 open" }, "body"));
    expect(open).toMatch(/<h3[^>]*><button[^>]*aria-expanded="true"/);
    expect(open).toContain(">7<");
    expect(open).toContain("6 linked · 1 open");
    expect(open).toContain("body");
    const closed = render(createElement(DetailsSection, { id: "sourcing", title: "Sourcing", summary: "DolphinRC · $69.99", defaultOpen: false }, "body"));
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain("DolphinRC · $69.99");
    expect(closed).not.toContain(">body<");
  });

  it("many interfaces: ten at a time, Show 10 more, Show fewer, and an expanded card is never hidden (PB-1088)", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ ...slots[0], id: `s${i}`, name: `Slot ${i}` }));
    const first = render(createElement(InterfaceCards, { slots: many, actions: {} }));
    expect(first.match(/data-slot="/g)).toHaveLength(10);
    expect(first).toContain("Show 10 more");
    expect(first).not.toContain("Show fewer");
    keptInspectorState.setExpanded("node:stack", new Set(["s15"]));
    const html = render(createElement(InterfaceCards, { slots: many, actions: {} }));
    expect(html.match(/data-slot="/g)).toHaveLength(16);
    expect(html).toContain('data-slot="s15"');
    expect(html).toContain("Show 9 more");
    expect(html).toContain("Show fewer");
    // ten or fewer: no footer
    expect(render(createElement(InterfaceCards, { slots: many.slice(0, 10), actions: {} }))).not.toContain("data-load-more");
  });

  it("a long description: five lines and More; a short one has no toggle (PB-1088)", () => {
    const long = "A paragraph of design notes. ".repeat(40);
    const html = render(createElement(ClampedText, { text: long, lines: 5 }));
    expect(html).toContain("data-clamped");
    expect(html).toContain("-webkit-line-clamp:5");
    expect(html).toContain(">More<");
    const short = render(createElement(ClampedText, { text: "Main flight controller stack.", lines: 5 }));
    expect(short).not.toContain("data-clamped");
    expect(short).not.toContain(">More<");
  });
});

describe("every interface is listed (PB-1071)", () => {
  // a part whose UART is a group binding two pins: the outline draws the UART, the pins are behind it
  const part = {
    id: "mcu",
    name: "MCU board",
    interfaces: [
      { id: "uart1", name: "UART1", domain: "electrical", exposed: true, protocols: [{ type: "uart", roles: ["host"] }], slots: [{ id: "rx" }, { id: "tx" }], profiles: [{ id: "default", bindings: { rx: "pa10", tx: "pa9" } }] },
      leaf("pa10", "PA10", "digital", "input"),
      leaf("pa9", "PA9", "digital", "output"),
      leaf("vin", "VIN", "power", "input"),
      { id: "boot", name: "BOOT", domain: "electrical", exposed: false, protocols: [{ type: "digital", roles: ["input"] }] },
    ],
  } as unknown as ModuleDef;
  const root = { id: "root", name: "Root", interfaces: [], children: [{ id: "mcu", moduleDefId: "mcu", name: "MCU" }], links: [] } as unknown as ModuleDef;
  const find = (id: string) => (id === "mcu" ? part : id === "root" ? root : undefined);
  const view = buildView(root, find, [], { expanded: new Set() });
  const node = view.nodes.find((n) => n.id === "mcu")!;
  const all = interfaceSlots(node, view, { lookup: find });

  it("the outline draws only the primary interfaces", () => {
    expect(node.ports.map((p) => p.id).sort()).toEqual(["uart1", "vin"]);
  });

  it("the cards list every interface of the definition, the pins bound into another last, saying which", () => {
    expect(all.map((s) => s.id).sort()).toEqual(["boot", "pa10", "pa9", "uart1", "vin"]);
    expect(slotSummary(all).total).toBe(5);
    const pin = all.find((s) => s.id === "pa10")!;
    expect(pin.partOf).toBe("UART1");
    expect(pin.open).toBe(false);
    expect(all.slice(-2).map((s) => s.id).sort()).toEqual(["pa10", "pa9"]);
    // an interface not exposed on the outline is listed too
    expect(all.find((s) => s.id === "boot")!.open).toBe(true);
    expect(renderToStaticMarkup(createElement(InterfaceCards, { slots: all, actions: {} }))).toContain("part of UART1");
  });
});
