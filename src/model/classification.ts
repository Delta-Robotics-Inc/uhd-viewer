import type { LinkState } from "./types";

/**
 * Interface/harness classification (design decision D7): the rule that
 * colours ports and links. Domain is the default.
 */
export type Classification = "domain" | "drc" | "signal";

export const CLASSIFICATIONS: { id: Classification; label: string }[] = [
  { id: "domain", label: "Domain" },
  { id: "drc", label: "DRC health" },
  { id: "signal", label: "Signal" },
];

const DOMAIN_COLORS: Record<string, string> = {
  electrical: "var(--uhd-domain-electrical)",
  mechanical: "var(--uhd-domain-mechanical)",
  pneumatic: "var(--uhd-domain-pneumatic)",
  hydraulic: "var(--uhd-domain-hydraulic)",
  thermal: "var(--uhd-domain-thermal)",
  network: "var(--uhd-domain-network)",
  software: "var(--uhd-domain-software)",
};

const DRC_COLORS: Record<LinkState, string> = {
  configured: "var(--uhd-drc-configured)",
  partial: "var(--uhd-drc-partial)",
  incompatible: "var(--uhd-drc-incompatible)",
  unconfigured: "var(--uhd-drc-unconfigured)",
};

const SIGNAL_COLORS: Record<string, string> = {
  power: "var(--uhd-signal-power)",
  ground: "var(--uhd-signal-ground)",
  bldc_3phase: "var(--uhd-signal-phase)",
  bldc_phase: "var(--uhd-signal-phase)",
  dshot: "var(--uhd-signal-pwm)",
  fc_esc_connector: "var(--uhd-signal-pwm)",
  pwm: "var(--uhd-signal-pwm)",
  pwm_esc: "var(--uhd-signal-pwm)",
  uart: "var(--uhd-signal-uart)",
  crsf: "var(--uhd-signal-uart)",
  sbus: "var(--uhd-signal-uart)",
  i2c: "var(--uhd-signal-i2c)",
  spi: "var(--uhd-signal-spi)",
  analog: "var(--uhd-signal-analog)",
  digital: "var(--uhd-signal-digital)",
  can: "var(--uhd-signal-can)",
  rf: "var(--uhd-signal-rf)",
};

export interface Colorable {
  domain: string;
  protocol: string;
  state?: LinkState;
}

export function colorFor(item: Colorable, mode: Classification): string {
  if (mode === "drc") return DRC_COLORS[item.state ?? "unconfigured"];
  if (mode === "signal") {
    if (item.domain !== "electrical") return "var(--uhd-domain-other)";
    return signalColor(item.protocol);
  }
  return DOMAIN_COLORS[item.domain] ?? "var(--uhd-signal-other)";
}

/** Items outside the classification's focus are faded (signal mode shows electrical only). */
export function isFaded(item: Colorable, mode: Classification): boolean {
  return mode === "signal" && item.domain !== "electrical";
}

/** One entry of a classification's legend. `key` is what `classKey` gives the items it stands for. */
export interface LegendEntry {
  key: string;
  /** Its name, as the legend shows it. */
  label: string;
  /** What it stands for, in a few words (the legend's second line). */
  meaning: string;
  color: string;
}

/** The legend entry an item belongs to in a classification (the key of its colour). */
export function classKey(item: Colorable, mode: Classification): string {
  if (mode === "drc") return item.state ?? "unconfigured";
  if (mode === "signal") return item.domain !== "electrical" ? "other-domains" : signalKey(item.protocol);
  return item.domain in DOMAIN_COLORS ? item.domain : "other";
}

const DRC_LEGEND: LegendEntry[] = [
  { key: "configured", label: "Configured", meaning: "No findings", color: DRC_COLORS.configured },
  { key: "partial", label: "Partial", meaning: "Warnings", color: DRC_COLORS.partial },
  { key: "incompatible", label: "Incompatible", meaning: "Errors", color: DRC_COLORS.incompatible },
  { key: "unconfigured", label: "Not configured", meaning: "Nothing linked", color: DRC_COLORS.unconfigured },
];

const SIGNAL_LEGEND: LegendEntry[] = [
  { key: "power", label: "Power", meaning: "Supply rails", color: SIGNAL_COLORS.power },
  { key: "ground", label: "Ground", meaning: "Return paths", color: SIGNAL_COLORS.ground },
  { key: "phase", label: "Motor phase", meaning: "ESC to motor windings", color: SIGNAL_COLORS.bldc_3phase },
  { key: "pwm", label: "DShot / ESC", meaning: "Motor control", color: SIGNAL_COLORS.dshot },
  { key: "uart", label: "UART / CRSF", meaning: "Serial links", color: SIGNAL_COLORS.uart },
  { key: "i2c", label: "I2C", meaning: "Sensor bus", color: SIGNAL_COLORS.i2c },
  { key: "rf", label: "RF", meaning: "Antenna feeds", color: SIGNAL_COLORS.rf },
  { key: "other-domains", label: "Other domains", meaning: "Not electrical", color: "var(--uhd-domain-other)" },
];

/** Signal types the legend lists only where the level has them. */
const SIGNAL_EXTRA: LegendEntry[] = [
  { key: "spi", label: "SPI", meaning: "Peripheral bus", color: SIGNAL_COLORS.spi },
  { key: "analog", label: "Analog", meaning: "Analog signals", color: SIGNAL_COLORS.analog },
  { key: "digital", label: "Digital", meaning: "Logic I/O", color: SIGNAL_COLORS.digital },
  { key: "can", label: "CAN", meaning: "Field bus", color: SIGNAL_COLORS.can },
  { key: "other", label: "Other signals", meaning: "Unclassified protocols", color: "var(--uhd-signal-other)" },
];

const DOMAIN_LEGEND: LegendEntry[] = [
  { key: "electrical", label: "Electrical", meaning: "Power and signals", color: DOMAIN_COLORS.electrical },
  { key: "mechanical", label: "Mechanical", meaning: "Mounts and fasteners", color: DOMAIN_COLORS.mechanical },
  { key: "pneumatic", label: "Pneumatic", meaning: "Air lines", color: DOMAIN_COLORS.pneumatic },
  { key: "hydraulic", label: "Hydraulic", meaning: "Fluid lines", color: DOMAIN_COLORS.hydraulic },
  { key: "thermal", label: "Thermal", meaning: "Heat paths", color: DOMAIN_COLORS.thermal },
  { key: "network", label: "Network", meaning: "Data links", color: DOMAIN_COLORS.network },
];

const DOMAIN_EXTRA: LegendEntry[] = [
  { key: "software", label: "Software", meaning: "Software interfaces", color: DOMAIN_COLORS.software },
  { key: "other", label: "Other", meaning: "Other domains", color: "var(--uhd-signal-other)" },
];

/**
 * What the colours of a classification mean. With `present` (the keys drawn
 * on the level, `presentKeys`), the entries the fixed list leaves out (SPI,
 * CAN, a domain of its own…) are added where the level has them, so every
 * colour on screen has an entry to read and to isolate.
 */
export function legendFor(mode: Classification, present?: ReadonlySet<string>): LegendEntry[] {
  const [base, extra] = mode === "drc" ? [DRC_LEGEND, []] : mode === "signal" ? [SIGNAL_LEGEND, SIGNAL_EXTRA] : [DOMAIN_LEGEND, DOMAIN_EXTRA];
  if (!present) return base;
  const added = extra.filter((e) => present.has(e.key));
  if (!added.length) return base;
  // "other domains" stays last
  const tail = base.filter((e) => e.key === "other-domains");
  return [...base.filter((e) => e.key !== "other-domains"), ...added, ...tail];
}

/** The legend group of a signal type: the protocols that share a colour share a key ("crsf" is a UART). */
const SIGNAL_GROUPS: Record<string, string> = {
  power: "power",
  ground: "ground",
  bldc_3phase: "phase",
  bldc_phase: "phase",
  dshot: "pwm",
  fc_esc_connector: "pwm",
  pwm: "pwm",
  pwm_esc: "pwm",
  uart: "uart",
  crsf: "uart",
  sbus: "uart",
  i2c: "i2c",
  spi: "spi",
  analog: "analog",
  digital: "digital",
  can: "can",
  rf: "rf",
};

const signalBase = (protocol: string) => Object.keys(SIGNAL_COLORS).find((k) => protocol === k || protocol.startsWith(`${k}_`));

function signalKey(protocol: string): string {
  const base = signalBase(protocol);
  return base ? SIGNAL_GROUPS[base] ?? "other" : "other";
}

/** Signal-type colour: one table for links, lanes and conductors ("uart_tx" is a UART). */
function signalColor(protocol: string): string {
  const base = signalBase(protocol);
  return base ? SIGNAL_COLORS[base] : "var(--uhd-signal-other)";
}

/** Colour of one conductor in signal mode (the same table as links and lanes). */
export const conductorColor = signalColor;
