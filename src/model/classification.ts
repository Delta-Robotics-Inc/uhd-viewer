import type { LinkState } from "./types";

/**
 * Interface/harness classification (design decision D7): the rule that
 * colours ports and links. Domain is the default.
 */
export type Classification = "domain" | "drc" | "signal";

export const CLASSIFICATIONS: { id: Classification; label: string }[] = [
  { id: "domain", label: "DOMAIN" },
  { id: "drc", label: "DRC HEALTH" },
  { id: "signal", label: "ELECTRICAL · SIGNAL" },
];

const DOMAIN_COLORS: Record<string, string> = {
  electrical: "var(--dom-electrical)",
  mechanical: "var(--dom-mechanical)",
  pneumatic: "var(--dom-pneumatic)",
  hydraulic: "var(--dom-hydraulic)",
  thermal: "var(--dom-thermal)",
  network: "var(--dom-network)",
  software: "var(--dom-software)",
};

const DRC_COLORS: Record<LinkState, string> = {
  configured: "var(--drc-configured)",
  partial: "var(--drc-partial)",
  incompatible: "var(--drc-incompatible)",
  unconfigured: "var(--drc-unconfigured)",
};

const SIGNAL_COLORS: Record<string, string> = {
  power: "var(--sig-power)",
  bldc_3phase: "var(--sig-phase)",
  bldc_phase: "var(--sig-phase)",
  dshot: "var(--sig-pwm)",
  fc_esc_connector: "var(--sig-pwm)",
  pwm: "var(--sig-pwm)",
  pwm_esc: "var(--sig-pwm)",
  uart: "var(--sig-uart)",
  crsf: "var(--sig-uart)",
  sbus: "var(--sig-uart)",
  i2c: "var(--sig-i2c)",
  spi: "var(--sig-spi)",
  analog: "var(--sig-analog)",
  digital: "var(--sig-digital)",
  can: "var(--sig-can)",
  rf: "var(--sig-rf)",
};

export interface Colorable {
  domain: string;
  protocol: string;
  state?: LinkState;
}

export function colorFor(item: Colorable, mode: Classification): string {
  if (mode === "drc") return DRC_COLORS[item.state ?? "unconfigured"];
  if (mode === "signal") {
    if (item.domain !== "electrical") return "#3a3a3a";
    return SIGNAL_COLORS[item.protocol] ?? "var(--sig-other)";
  }
  return DOMAIN_COLORS[item.domain] ?? "var(--sig-other)";
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
      { label: "MOTOR PHASE", color: SIGNAL_COLORS.bldc_3phase },
      { label: "DSHOT / ESC", color: SIGNAL_COLORS.dshot },
      { label: "UART / CRSF", color: SIGNAL_COLORS.uart },
      { label: "I2C", color: SIGNAL_COLORS.i2c },
      { label: "RF", color: SIGNAL_COLORS.rf },
      { label: "OTHER DOMAINS", color: "#3a3a3a" },
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
