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

export function legendFor(mode: Classification): { label: string; color: string }[] {
  if (mode === "drc") {
    return [
      { label: "CONFIGURED", color: DRC_COLORS.configured },
      { label: "PARTIAL", color: DRC_COLORS.partial },
      { label: "INCOMPATIBLE", color: DRC_COLORS.incompatible },
      { label: "NOT CONFIGURED", color: DRC_COLORS.unconfigured },
    ];
  }
  if (mode === "signal") {
    return [
      { label: "POWER", color: SIGNAL_COLORS.power },
      { label: "GROUND", color: SIGNAL_COLORS.ground },
      { label: "MOTOR PHASE", color: SIGNAL_COLORS.bldc_3phase },
      { label: "DSHOT / ESC", color: SIGNAL_COLORS.dshot },
      { label: "UART / CRSF", color: SIGNAL_COLORS.uart },
      { label: "I2C", color: SIGNAL_COLORS.i2c },
      { label: "RF", color: SIGNAL_COLORS.rf },
      { label: "OTHER DOMAINS", color: "var(--uhd-domain-other)" },
    ];
  }
  return [
    { label: "ELECTRICAL", color: DOMAIN_COLORS.electrical },
    { label: "MECHANICAL", color: DOMAIN_COLORS.mechanical },
    { label: "PNEUMATIC", color: DOMAIN_COLORS.pneumatic },
    { label: "HYDRAULIC", color: DOMAIN_COLORS.hydraulic },
    { label: "THERMAL", color: DOMAIN_COLORS.thermal },
    { label: "NETWORK", color: DOMAIN_COLORS.network },
  ];
}

/** Signal-type colour: one table for links, lanes and conductors ("uart_tx" is a UART). */
function signalColor(protocol: string): string {
  const base = Object.keys(SIGNAL_COLORS).find((k) => protocol === k || protocol.startsWith(`${k}_`));
  return base ? SIGNAL_COLORS[base] : "var(--uhd-signal-other)";
}

/** Colour of one conductor in signal mode (the same table as links and lanes). */
export const conductorColor = signalColor;
