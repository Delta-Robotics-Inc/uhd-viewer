/**
 * A module's interfaces as the inspector's slot cards (PB-1042, design A with
 * expandable cards, 2026-10-21): what each interface is (its kind, protocol,
 * role and pins), what it is linked to and through which harness, and, for
 * the card opened, its pin mapping, its stated parameters, its links and the
 * links derived over them with their state, its findings, its notes and
 * assumptions, and the sources it cites. Plain data from the view model and
 * the definitions; nothing here draws.
 */
import type { InterfaceDef, ModuleDef } from "@uhd/types/index.js";
import type { LinkState, ViewLink, ViewModel, ViewNode, ViewPort } from "./types";
import { toPort } from "./from-uhd";

export type SlotKind = "power" | "signal" | "mechanical";

/** A link's state in the inspector's words: a stored link is configured, a derived one compatible. */
export type SlotState = "configured" | "compatible" | "warning" | "incompatible" | "unconfigured";

/** One pin or slot of the interface, the leaf it binds, and what it meets on the other side. */
export interface SlotPin {
  /** The pin or slot as the board names it ("RX2", "BAT+"). */
  pin: string;
  /** The leaf interface it binds on this module ("uart2_rx"), when it is not the pin itself. */
  leaf?: string;
  /** `←` into this module, `→` out of it, `—` a shared return (ground), `↔` both or not known. */
  dir: "←" | "→" | "—" | "↔";
  /** The pin it meets on the other side, and that module's name. */
  other?: string;
  otherModule?: string;
}

export interface SlotParam {
  label: string;
  value: string;
}

export interface SlotLink {
  /** The link's id as its module declares it ("rx_pads"), or a derived link's name. */
  label: string;
  /** Its name as declared ("Receiver wires on the FC"). */
  name?: string;
  /** What to select in the viewer for it: a canonical id on the level shown. */
  select: string;
  /** The harness or cable it runs through. */
  via?: string;
  state: SlotState;
  /** A link UHD derives over this one (through a cable's conductors, over a net). */
  derived?: boolean;
  /** The finding messages the viewer's checks put on it. */
  diagnostics: string[];
}

export interface SlotFinding {
  /** The host's key for it, when the host gave the finding (its Locate). */
  key?: string;
  code: string;
  message: string;
  severity: "error" | "warning" | "info";
}

export interface SlotNote {
  /** What the trait is ("Usage note", "Assumption", "Data gap"). */
  label: string;
  text: string;
  /** An `assumption` trait, or a relation stated as assumed: marked as such. */
  assumption?: boolean;
}

export interface SlotSource {
  label: string;
  url: string;
}

export interface InterfaceSlot {
  /** The port's id on the module. */
  id: string;
  name: string;
  kind: SlotKind;
  /** "UART · CRSF", "Power in", "USB". */
  protocol?: string;
  /** "host", "sink", "source", "device". */
  role?: string;
  /** Its pins, as chips. */
  pins: string[];
  /** The modules it is linked to, each with the harness the link runs through. */
  linked: { module: string; via?: string }[];
  /** Linked to nothing, and not part of an interface that is. */
  open: boolean;
  /** Linked through another interface of the module that binds it (an exported pad inside a linked pad group). */
  usedBy?: string;
  /** Exported to the boundary of the module it is in, by that name: linked from outside, not open. */
  exportedAs?: string;
  /** A pin bound into another interface of the module (a UART's RX inside its pad group), by that one's name: not on the outline, not linked on its own. */
  partOf?: string;
  /** The worst state of its links. */
  state?: SlotState;
  pinMap: SlotPin[];
  params: SlotParam[];
  links: SlotLink[];
  findings: SlotFinding[];
  notes: SlotNote[];
  sources: SlotSource[];
  /** Canonical refs of the interface and its links, for findings and Locate (`stack:rx_fc_pads`, `rx_pads`). */
  refs: string[];
  /** A card for several alike interfaces (Motor pads ×4): their ids. */
  members?: string[];
  /** What such a card is linked to, said once ("4 arms" via "Motor phase leads"). */
  together?: { module: string; via?: string };
}

/** A finding the host knows about, with the canonical ids it is about (links as the viewer selects them, interfaces as `path:id`). */
export interface HostFinding {
  key: string;
  code: string;
  message: string;
  severity: "error" | "warning" | "info";
  refs: string[];
}

export interface SlotOptions {
  /** Definitions by id: the module's own, its children's (leaves bound by its pad groups) and the other ends'. */
  lookup: (id: string) => ModuleDef | undefined;
  /** The level the view model is of, from the root (canonical ids are joined to it). */
  drill?: string[];
  /** Names as written in the model, by node id on the level (the view model's labels are upper case). */
  names?: Map<string, string>;
  /** Link names as declared, by link id on the level. */
  linkNames?: Map<string, string>;
  /** Findings of the host (with their keys) or of the viewer's own checks. */
  findings?: HostFinding[];
}

const RANK: Record<SlotState, number> = { configured: 0, compatible: 0, unconfigured: 1, warning: 2, incompatible: 3 };

const STORED: Record<LinkState, SlotState> = { configured: "configured", partial: "warning", incompatible: "incompatible", unconfigured: "unconfigured" };
const DERIVED: Record<LinkState, SlotState> = { configured: "compatible", partial: "warning", incompatible: "incompatible", unconfigured: "unconfigured" };

const join = (drill: string[] | undefined, id: string) => {
  const at = (drill ?? []).join("/");
  if (!at) return id;
  return id.startsWith(":") ? `${at}${id}` : `${at}/${id}`;
};

const ACRONYMS = new Set(["rx", "tx", "fc", "esc", "gnss", "gps", "usb", "uart", "i2c", "spi", "can", "dji", "vtx", "led", "pwm", "adc", "gnd", "vcc", "bec", "sbus", "crsf", "imu", "mcu", "rf", "swd", "jtag", "io", "gpio", "ic"]);

/** "max_current" → "Max current", "rx_fc_pads" → "RX FC pads". */
export function humanize(id: string): string {
  const words = id.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().split(" ");
  const s = words.map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w)).join(" ");
  return s ? s[0].toUpperCase() + s.slice(1) : id;
}

/** "BATTERY LEAD" → "Battery lead": a label the view model upper-cased, back in sentence case. */
export function sentence(label: string): string {
  if (label !== label.toUpperCase()) return label;
  const lower = label.toLowerCase();
  return lower[0]?.toUpperCase() + lower.slice(1);
}

/** A pin as a reader names it: its pad label, unless that is a bare sign ("+"), then its name ("BAT+"). */
const pinLabel = (c: { pin?: string; name: string }) => (c.pin && /[A-Za-z0-9]/.test(c.pin) ? c.pin : c.name || c.pin || "");

const number = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));

/** A parameter with its unit: "5 V", "6–30 V", "2–6" (dimensionless). */
export function paramValue(p: { value?: number; unit?: string; range?: [number, number] }): string | undefined {
  const unit = !p.unit || p.unit === "dimensionless" ? "" : ` ${p.unit}`;
  if (typeof p.value === "number") return `${number(p.value)}${unit}`;
  if (Array.isArray(p.range) && p.range.length === 2) return `${number(p.range[0])}–${number(p.range[1])}${unit}`;
  return undefined;
}

/** An interface by id: the module's own, an export's child interface, or a leaf of a child (one or two levels down). */
export function findInterface(def: ModuleDef | undefined, id: string, lookup: SlotOptions["lookup"], depth = 2): InterfaceDef | undefined {
  if (!def) return undefined;
  const own = def.interfaces?.find((i) => i.id === id);
  if (own) return own;
  const exported = def.exports?.find((e) => e.id === id);
  if (exported && "child" in exported.from) {
    const ref = def.children?.find((c) => c.id === (exported.from as { child: string }).child);
    const found = ref ? findInterface(lookup(ref.moduleDefId), exported.from.interfaceId, lookup, depth) : undefined;
    if (found) return found;
  }
  if (depth <= 0) return undefined;
  for (const ref of def.children ?? []) {
    const found = findInterface(lookup(ref.moduleDefId), id, lookup, depth - 1);
    if (found) return found;
  }
  return undefined;
}

const roles = (i?: InterfaceDef) => (i?.protocols ?? []).flatMap((p) => p.roles ?? []);
const protocols = (i?: InterfaceDef) => (i?.protocols ?? []).map((p) => p.type);

/** Which way a pin faces, from its leaf's roles, else from its name. */
export function direction(leaf: InterfaceDef | undefined, name: string): SlotPin["dir"] {
  const r = roles(leaf);
  if (r.includes("ground") || /^(gnd|g|ground|bat-|-)$/i.test(name)) return "—";
  if (r.some((x) => /^(input|receiver|rx|sink|slave_in|in)$/.test(x))) return "←";
  if (r.some((x) => /^(output|transmitter|tx|source|out)$/.test(x))) return "→";
  if (/(^|[^a-z])(rx|r)\d*$|_rx$|^rx|in$/i.test(name)) return "←";
  if (/(^|[^a-z])(tx|t)\d*$|_tx$|^tx|out$/i.test(name)) return "→";
  return "↔";
}

const SIGNAL = /^(uart|i2c|spi|can|usb|crsf|sbus|digital|analog|pwm|gpio|dshot|onewire|1wire|i2s|ethernet|rf|serial|swd|jtag|adc|video)/i;
const POWER = /^(power|ground|bldc|motor|battery|dc)/i;

/** Power (red), signal (blue) or mechanical (grey): the slot glyph's colour. */
export function slotKind(port: ViewPort, leaves: (InterfaceDef | undefined)[], lanes: string[]): SlotKind {
  if (port.domain === "mechanical" || /bolt|mount|shaft|thread|mate_mech/i.test(port.protocol)) return "mechanical";
  const all = [port.protocol, ...leaves.flatMap(protocols), ...lanes];
  if (all.some((p) => SIGNAL.test(p))) return "signal";
  if (all.some((p) => POWER.test(p))) return "power";
  return port.domain === "electrical" || port.domain === "network" || port.domain === "software" ? "signal" : "mechanical";
}

const SHORT: Record<string, string> = { power: "Power", ground: "Ground", bldc_3phase: "3-phase", bldc_phase: "3-phase", connector: "Connector", bolt_pattern: "Bolt pattern", digital: "Digital" };
const word = (p: string) => SHORT[p] ?? (p.length <= 5 ? p.toUpperCase() : humanize(p));

/** What it speaks, shortest first: the signal protocols it carries, else power in or out, else its own type. */
function protocolLabel(port: ViewPort, iface: InterfaceDef | undefined, leaves: (InterfaceDef | undefined)[], lanes: string[]): string | undefined {
  const own = [...protocols(iface), port.protocol].filter((p) => p && p !== "connector" && p !== "net");
  const carried = [...lanes, ...leaves.flatMap(protocols)].filter((p) => p !== "power" && p !== "ground" && p !== "connector");
  const signals = [...new Set([...own, ...carried].filter((p) => p !== "power" && p !== "ground"))];
  const words = [...new Set(signals.map(word))];
  // a bus names itself: I2C's pins are digital too
  const named = words.length > 1 ? words.filter((w) => w !== "Digital") : words;
  if (named.length) return named.slice(0, 2).join(" · ");
  const r = [...roles(iface), ...leaves.flatMap(roles)];
  const power = [...own, ...lanes, ...leaves.flatMap(protocols)].some((p) => p === "power" || p === "ground");
  if (power) return r.includes("output") || r.includes("source") ? "Power out" : r.includes("input") || r.includes("sink") ? "Power in" : "Power";
  return port.protocol ? word(port.protocol) : undefined;
}

function roleLabel(port: ViewPort, iface: InterfaceDef | undefined, leaves: (InterfaceDef | undefined)[]): string | undefined {
  const r = [...port.roles, ...roles(iface)].filter((x) => x !== "mate" && x !== "net" && x !== "component");
  if (r.length) {
    const x = r[0];
    return x === "input" ? "sink" : x === "output" ? "source" : x;
  }
  // a pad group's pins: a sink or a source when they all face one way; mixed (a UART with its supply) says nothing
  const lr = leaves.flatMap(roles).filter((x) => x !== "ground");
  if (lr.some((x) => x === "receiver" || x === "transmitter" || x === "bidirectional")) return undefined;
  if (lr.length && lr.every((x) => x === "input")) return "sink";
  if (lr.length && lr.every((x) => x === "output")) return "source";
  return undefined;
}

/** The text of a trait a reader needs: a note, a description, a reason, an assumption. */
function traitText(t: { type: string; params?: Record<string, unknown> }): SlotNote | undefined {
  const p = t.params ?? {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  if (t.type === "assumption") {
    const field = str(p.field);
    const text = [field ? `${field}${str(p.value) ? ` = ${str(p.value)}` : ""}` : undefined, str(p.reason) ?? str(p.note)].filter(Boolean).join(": ");
    return text ? { label: "Assumption", text, assumption: true } : undefined;
  }
  if (str(p.assumption)) return { label: humanize(t.type), text: str(p.assumption)!, assumption: true };
  const text = str(p.note) ?? str(p.description) ?? str(p.reason) ?? str(p.resolution);
  if (!text) return undefined;
  const label = t.type === "pin_functions" ? "Pin function" : humanize(t.type);
  return { label, text };
}

function sourcesOf(t: { params?: Record<string, unknown> }): string[] {
  const p = t.params ?? {};
  const out: string[] = [];
  for (const v of [p.source, p.sources]) {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) out.push(...v.filter((x): x is string => typeof x === "string"));
  }
  return out.map((s) => s.trim().split(/\s/)[0]).filter((s) => /^https?:\/\//i.test(s));
}

/** "dolphinrc.com · …e-165929bb5a.pdf": where a source is, short. */
export function sourceLabel(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    if (!last) return host;
    return `${host} · ${last.length > 28 ? `…${last.slice(-26)}` : last}`;
  } catch {
    return url;
  }
}

/** The other end of a link from this node: the node and port, through a harness drawn as two segments. */
function otherEnd(vm: ViewModel, link: ViewLink, nodeId: string): { node: string; port: string } | undefined {
  const mine = link.source.node === nodeId ? link.source : link.target;
  const theirs = mine === link.source ? link.target : link.source;
  if (!link.segment || !link.harness || theirs.node !== link.harness) return theirs;
  const twin = vm.links.find((l) => l.linkId === link.linkId && l !== link);
  if (!twin) return theirs;
  return twin.source.node === link.harness ? twin.target : twin.source;
}

/** Every interface of the node as a slot card, linked ones first, then open ones, then those used through another. */
export function interfaceSlots(node: ViewNode, vm: ViewModel, opts: SlotOptions): InterfaceSlot[] {
  const { lookup } = opts;
  const def = node.defId ? lookup(node.defId) : undefined;
  const nameOf = (id: string) => opts.names?.get(id) ?? sentence(vm.nodes.find((n) => n.id === id)?.label ?? id);
  const nodePath = join(opts.drill, node.id);
  const at = (id: string) => join(opts.drill, id);
  const lines = vm.links.filter((l) => !l.passThrough && (l.source.node === node.id || l.target.node === node.id));
  const linksOf = (port: string) => {
    const mine = lines.filter((l) => (l.source.node === node.id && l.source.port === port) || (l.target.node === node.id && l.target.port === port));
    // one entry per stored link (a harness's two segments are one)
    return mine.filter((l, i) => mine.findIndex((m) => m.linkId === l.linkId) === i);
  };
  // every interface of the definition (PB-1071): the outline's ports, then those the outline does not draw (pins bound
  // into another interface, interfaces not exposed)
  const drawn = new Set(node.ports.map((p) => p.id));
  const ports: ViewPort[] = [...node.ports, ...(def && node.kind !== "harness" ? def.interfaces.filter((i) => !drawn.has(i.id)).map((i) => toPort(i, def)) : [])];
  // the interface each pin is bound into, by name
  const boundInto = new Map<string, string>();
  for (const i of def?.interfaces ?? [])
    for (const profile of i.profiles ?? [])
      for (const v of Object.values(profile.bindings))
        for (const id of Array.isArray(v) ? v : [v]) if (id !== i.id && !boundInto.has(id)) boundInto.set(id, i.name && i.name !== i.id ? i.name : humanize(i.id));
  const linkedIds = new Set(ports.filter((p) => linksOf(p.id).length).map((p) => p.id));
  // an interface the module it is in exports (a pass-through to the drilled module's edge): reached from outside
  const exportedAs = new Map<string, string>();
  for (const l of vm.links)
    if (l.passThrough && l.target.node === node.id && !exportedAs.has(l.target.port)) exportedAs.set(l.target.port, l.name);
  // an exported pad that a linked pad group binds is in use through that group
  const usedBy = new Map<string, string>();
  for (const p of ports) if (linkedIds.has(p.id)) for (const c of p.children) if (c.leafId && !usedBy.has(c.leafId)) usedBy.set(c.leafId, p.name === p.id ? humanize(p.id) : p.name);
  // an interface whose own pins are bound there too (UART2, whose RX2 and TX2 are receiver pads)
  for (const p of ports) {
    if (linkedIds.has(p.id) || usedBy.has(p.id)) continue;
    const via = p.children.map((c) => c.leafId && usedBy.get(c.leafId)).find(Boolean);
    if (via) usedBy.set(p.id, via);
  }

  const slots = ports.map((port): InterfaceSlot => {
    const iface = findInterface(def, port.id, lookup);
    const leaves = port.children.map((c) => (c.leafId ? findInterface(def, c.leafId, lookup) : undefined));
    const links = linksOf(port.id);
    const lanes = links.flatMap((l) => l.lanes ?? []);
    const laneProtocols = lanes.map((l) => l.protocol);
    const ends = links.map((l) => ({ link: l, end: otherEnd(vm, l, node.id) }));
    const otherPort = (end?: { node: string; port: string }) => (end ? vm.nodes.find((n) => n.id === end.node)?.ports.find((p) => p.id === end.port) : undefined);

    // the pin mapping: each pin, its leaf, and the pin it meets across the link (a cable's conductors keep their positions)
    const pinMap: SlotPin[] = [];
    const rows = port.children.length ? port.children : [{ slotId: port.id, name: port.name, leafId: undefined, pin: undefined as string | undefined }];
    rows.forEach((c, i) => {
      const leaf = port.children.length ? leaves[i] : iface;
      const pin = pinLabel(c);
      const first = ends[0];
      let other: string | undefined;
      let otherModule: string | undefined;
      if (first?.end) {
        otherModule = nameOf(first.end.node);
        const op = otherPort(first.end);
        const mineIsSource = first.link.source.node === node.id && first.link.source.port === port.id;
        const child = first.link.children.find((ch) => (mineIsSource ? ch.a : ch.b) === c.slotId);
        const counterpart = op?.children.find((x) => x.slotId === c.slotId);
        if (counterpart) other = pinLabel(counterpart);
        else if (child && (mineIsSource ? child.bPin ?? child.b : child.aPin ?? child.a)) other = mineIsSource ? child.bPin ?? child.b : child.aPin ?? child.a;
        else if (!port.children.length && op) other = op.name;
      }
      pinMap.push({
        pin,
        ...(c.leafId && c.leafId !== pin ? { leaf: c.leafId } : {}),
        dir: direction(leaf, pin),
        ...(other ? { other } : {}),
        ...(otherModule ? { otherModule } : {}),
      });
    });

    // what it states, with units: its own parameters, else its leaves' (named by pin when there are several)
    const params: SlotParam[] = [];
    const seen = new Set<string>();
    const add = (label: string, value: string | undefined) => {
      if (!value || seen.has(`${label}=${value}`) || params.length >= 10) return;
      seen.add(`${label}=${value}`);
      params.push({ label, value });
    };
    for (const p of iface?.protocols ?? []) {
      if (p.version) add("Version", `${word(p.type)} ${p.version}`);
      for (const [k, v] of Object.entries((p as { params?: Record<string, unknown> }).params ?? {})) if (typeof v === "string" || typeof v === "number") add(humanize(k), String(v));
    }
    for (const p of iface?.parameters ?? []) add(humanize(p.name ?? p.id), paramValue(p));
    // a pad group's are its pins': named by the pin ("5V voltage")
    for (const [i, l] of leaves.entries()) {
      for (const p of l?.parameters ?? []) add(`${pinLabel(rows[i])} ${humanize(p.name ?? p.id).toLowerCase()}`, paramValue(p));
    }

    // its links, and below each the links derived over it
    const linkNames = opts.linkNames;
    const slotLinks: SlotLink[] = [];
    for (const { link, end } of ends) {
      // a cable is two stored links, one at each end: the one that ends here names it
      const mineIsTarget = link.target.node === node.id && link.target.port === port.id && link.source.node !== node.id;
      const ownId = link.run?.physical && mineIsTarget && link.alsoIds?.length ? link.alsoIds[0] : link.linkId;
      const local = ownId.split("/").pop() ?? ownId;
      const via = link.run ? (opts.names?.get(link.run.id) ?? sentence(link.run.name)) : link.harness ? nameOf(link.harness) : undefined;
      slotLinks.push({
        label: local,
        ...(linkNames?.get(local) ? { name: linkNames.get(local)! } : {}),
        select: link.linkId,
        ...(via ? { via } : end ? { via: `to ${nameOf(end.node)}` } : {}),
        state: STORED[link.state],
        diagnostics: link.diagnostics,
      });
      for (const lane of link.lanes ?? []) slotLinks.push({ label: lane.name.length <= 4 ? lane.name : sentence(lane.name), select: lane.id, state: DERIVED[lane.state], derived: true, diagnostics: [] });
    }
    for (const d of vm.derived.filter((d) => (d.a.node === node.id && d.a.iface === port.id) || (d.b.node === node.id && d.b.iface === port.id)))
      slotLinks.push({ label: d.name, select: d.id, state: DERIVED[d.state], derived: true, diagnostics: d.diagnostics });

    // canonical refs: the interface, its leaves, its links (both halves of a cable), the links derived over them
    const refs = new Set<string>([`${nodePath}:${port.id}`]);
    for (const c of port.children) if (c.leafId) refs.add(`${nodePath}:${c.leafId}`);
    for (const l of links) {
      refs.add(at(l.linkId));
      for (const a of l.alsoIds ?? []) refs.add(at(a));
      for (const lane of l.lanes ?? []) refs.add(at(lane.id));
    }
    for (const s of slotLinks) if (s.derived) refs.add(at(s.select));
    const findings = (opts.findings ?? [])
      .filter((f) => f.refs.some((r) => refs.has(r)))
      .map((f): SlotFinding => ({ key: f.key, code: f.code, message: f.message, severity: f.severity }));

    // notes: its own traits, then its leaves' assumptions and usage notes
    const notes: SlotNote[] = [];
    const sources: string[] = [];
    const noted = new Set<string>();
    const note = (t: { type: string; params?: Record<string, unknown> }, own: boolean) => {
      sources.push(...sourcesOf(t));
      const n = traitText(t);
      if (!n || noted.has(n.text) || notes.length >= 6) return;
      if (!own && !n.assumption && t.type !== "usage_note" && t.type !== "data_gap") return;
      noted.add(n.text);
      notes.push(n);
    };
    for (const t of iface?.traits ?? []) note(t, true);
    for (const l of leaves) for (const t of l?.traits ?? []) note(t, false);
    const uniqueSources = [...new Set(sources)].slice(0, 3).map((url) => ({ label: sourceLabel(url), url }));

    const linked = ends.flatMap(({ link, end }) => (end ? [{ module: nameOf(end.node), ...(link.run ? { via: opts.names?.get(link.run.id) ?? sentence(link.run.name) } : link.harness ? { via: nameOf(link.harness) } : {}) }] : []));
    const states = slotLinks.map((s) => s.state);
    const state = states.length ? states.reduce((w, x) => (RANK[x] > RANK[w] ? x : w), "configured" as SlotState) : undefined;
    const pins = [...new Set(port.children.length ? port.children.map(pinLabel) : iface?.pin !== undefined ? [pinLabel({ pin: String(iface.pin), name: port.name })] : [])];
    const protocol = protocolLabel(port, iface, leaves, laneProtocols);
    const role = roleLabel(port, iface, leaves);
    return {
      id: port.id,
      name: port.name === port.id ? humanize(port.id) : port.name,
      kind: slotKind(port, leaves, laneProtocols),
      ...(protocol ? { protocol } : {}),
      ...(role ? { role } : {}),
      pins,
      linked: linked.filter((x, i) => linked.findIndex((y) => y.module === x.module && y.via === x.via) === i),
      open: !links.length && !usedBy.has(port.id) && !exportedAs.has(port.id) && !(!drawn.has(port.id) && boundInto.has(port.id)) && !vm.derived.some((d) => (d.a.node === node.id && d.a.iface === port.id) || (d.b.node === node.id && d.b.iface === port.id)),
      ...(!links.length && usedBy.has(port.id) ? { usedBy: usedBy.get(port.id)! } : {}),
      ...(!links.length && !usedBy.has(port.id) && exportedAs.has(port.id) ? { exportedAs: exportedAs.get(port.id)! } : {}),
      ...(!links.length && !usedBy.has(port.id) && !exportedAs.has(port.id) && !drawn.has(port.id) && boundInto.has(port.id) ? { partOf: boundInto.get(port.id)! } : {}),
      ...(state ? { state } : {}),
      pinMap,
      params,
      links: slotLinks,
      findings,
      notes,
      sources: uniqueSources,
      refs: [...refs],
    };
  });
  // linked power and signal first, then open slots, then mechanical ones, then those in use through another interface,
  // then the pins bound into another interface; the module's order within each
  // power before signal among the linked ones, as a reader traces a build: supply first
  const order = (s: InterfaceSlot) => (s.linked.length || s.links.length ? (s.kind === "mechanical" ? 3 : s.kind === "power" ? 0 : 1) : s.open ? 2 : s.partOf ? 5 : 4);
  const sorted = slots.map((s, i) => ({ s, i })).sort((a, b) => order(a.s) - order(b.s) || a.i - b.i).map((x) => x.s);
  return groupSlots(sorted);
}

/**
 * What a group is linked to, said once: "4 arms via Motor phase leads" when the modules share their last word and
 * the harnesses differ only by a number.
 */
function together(same: InterfaceSlot[]): { together?: { module: string; via?: string } } {
  const ends = same.flatMap((x) => x.linked);
  if (ends.length < 2) return {};
  const last = (n: string) => n.trim().split(/\s+/).pop()!.toLowerCase();
  const word = ends.every((e) => last(e.module) === last(ends[0].module)) ? last(ends[0].module) : undefined;
  const vias = [...new Set(ends.map((e) => (e.via ? shape(e.via).replace(/\s*#\s*/g, " ").replace(/\s+/g, " ").trim() : "")))];
  return { together: { module: word ? `${ends.length} ${word}s` : `${ends.length} modules`, ...(vias.length === 1 && vias[0] ? { via: vias[0] } : {}) } };
}

/** "Motor 2 pads" → "Motor # pads": what interfaces that differ only by a number have in common. */
const shape = (name: string) => name.replace(/\d+/g, "#");

/**
 * Interfaces that differ only by a number (Motor 1 pads … Motor 4 pads), alike in kind, protocol and state of
 * linking, as one card: "Motor pads ×4", its pins and its links those of every member. Three or more.
 */
export function groupSlots(slots: InterfaceSlot[]): InterfaceSlot[] {
  const out: InterfaceSlot[] = [];
  const key = (s: InterfaceSlot) => `${shape(s.name)}|${s.kind}|${s.protocol}|${s.linked.length ? "linked" : s.open ? "open" : s.exportedAs ? "exported" : s.partOf ? `part of ${s.partOf}` : "used"}`;
  for (const s of slots) {
    if (!/\d/.test(s.name)) {
      out.push(s);
      continue;
    }
    const same = slots.filter((x) => key(x) === key(s)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (same.length < 3) {
      out.push(s);
      continue;
    }
    if (!same.includes(s) || out.some((x) => x.members?.includes(s.id))) continue;
    const name = `${shape(s.name).replace(/\s*#\s*/g, " ").replace(/\s+/g, " ").trim()} ×${same.length}`;
    const uniq = <T,>(xs: T[], k: (x: T) => string) => xs.filter((x, i) => xs.findIndex((y) => k(y) === k(x)) === i);
    const states = same.map((x) => x.state).filter((x): x is SlotState => !!x);
    out.push({
      ...s,
      id: `group:${shape(s.id)}`,
      name,
      pins: uniq(same.flatMap((x) => x.pins), (x) => x),
      linked: uniq(same.flatMap((x) => x.linked), (x) => `${x.module}|${x.via}`),
      ...together(same),
      ...(states.length ? { state: states.reduce((w, x) => (RANK[x] > RANK[w] ? x : w)) } : {}),
      pinMap: same.flatMap((x) => x.pinMap),
      links: same.flatMap((x) => x.links),
      findings: uniq(same.flatMap((x) => x.findings), (f) => `${f.code}|${f.message}`),
      notes: uniq(same.flatMap((x) => x.notes), (n) => n.text),
      sources: uniq(same.flatMap((x) => x.sources), (x) => x.url),
      refs: [...new Set(same.flatMap((x) => x.refs))],
      members: same.map((x) => x.id),
    });
  }
  return out;
}

/** The Interfaces section's header: "6 linked · 1 open", counting each interface of a grouped card. */
export function slotSummary(slots: InterfaceSlot[]): { total: number; linked: number; open: number; used: number; text: string } {
  const n = (s: InterfaceSlot) => s.members?.length ?? 1;
  const sum = (xs: InterfaceSlot[]) => xs.reduce((t, s) => t + n(s), 0);
  const total = sum(slots);
  const linked = sum(slots.filter((s) => s.linked.length || s.links.length));
  const open = sum(slots.filter((s) => s.open));
  const used = total - linked - open;
  const text = [linked ? `${linked} linked` : "", open ? `${open} open` : ""].filter(Boolean).join(" · ") || (used ? `${used} in use` : "none linked");
  return { total, linked, open, used, text };
}

/**
 * The viewer's own findings as host findings: UHD's checks of the level and
 * the bundle producer's, each with the canonical ids it is about (links
 * without their `link:` prefix, re-based onto the root).
 */
export function checkFindings(
  checks: { id: string; rule: string; severity: "error" | "warning" | "info"; message: string; refs: string[]; scope?: string }[],
  producer: { code: string; severity: "error" | "warning" | "info"; message: string; entity?: { kind: string; id: string } }[] = [],
): HostFinding[] {
  const rebase = (ref: string, scope = "") => {
    const link = ref.startsWith("link:");
    const r = link ? ref.slice(5) : ref;
    if (!scope) return r;
    return r.startsWith(":") ? `${scope}${r}` : `${scope}/${r}`;
  };
  return [
    ...checks.map((d) => ({ key: d.id, code: `UHD_${d.rule.toUpperCase()}`, severity: d.severity, message: d.message, refs: d.refs.map((r) => rebase(r, d.scope)) })),
    ...producer.flatMap((d, i) => (d.entity && (d.entity.kind === "link" || d.entity.kind === "interface") ? [{ key: `producer:${i}`, code: d.code, severity: d.severity, message: d.message, refs: [d.entity.id] }] : [])),
  ].filter((f, i, all) => all.findIndex((g) => g.code === f.code && g.message === f.message) === i);
}

/** Names as written, by node id on a level (the view model's labels are upper case), and its links' names by id. */
export function levelNames(vm: ViewModel, level: ModuleDef | undefined, lookup: (id: string) => ModuleDef | undefined): { names: Map<string, string>; linkNames: Map<string, string> } {
  const names = new Map<string, string>();
  const nameAt = (path: string): string | undefined => {
    let def = level;
    let name: string | undefined;
    for (const part of path.split("/")) {
      const ref = def?.children?.find((c) => c.id === part);
      if (!ref) return undefined;
      const child = lookup(ref.moduleDefId);
      name = ref.name ?? child?.name;
      def = child;
    }
    return name;
  };
  const ids = new Set<string>(vm.nodes.map((n) => n.id));
  for (const l of vm.links) if (l.run) ids.add(l.run.id);
  for (const id of ids) {
    const n = nameAt(id);
    if (n) names.set(id, n);
  }
  const linkNames = new Map<string, string>();
  for (const l of level?.links ?? []) if (l.name) linkNames.set(l.id, l.name);
  return { names, linkNames };
}
