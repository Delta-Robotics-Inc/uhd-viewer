/**
 * The Interfaces section's slot cards (PB-1042, design A with expandable
 * cards, Mark 2026-10-21). A card says what the interface is (a pin glyph in
 * its kind's colour, the name, a protocol chip, the role and the pins) and
 * what it is linked to; an open slot says so and offers Connect…. A card
 * expands (a click anywhere on it, or Enter or Space on it) to its pin
 * mapping, its stated parameters, its links and the links derived over them
 * with their state, its findings, its notes and assumptions, its sources,
 * and its actions.
 *
 * Several cards may be open at once: a power and a signal interface can be
 * read side by side, and opening one never closes the one being read. The
 * open set is kept per selection while the page is open (Sections.tsx).
 */
import { useId, useState, type ReactNode } from "react";
import { Icon } from "../canvas/Icon";
import { cx } from "../ui/cx";
import type { InterfaceSlot, SlotKind, SlotState } from "../model/slots";
import { SECTION_LOOK, onNavKey, useExpandedCards } from "./Sections";

/** The card's look, in one place. */
export const CARD_LOOK = {
  list: "flex flex-col gap-1.5",
  card: "uhd-slot-card rounded-[6px] border border-line bg-[color-mix(in_oklab,var(--uhd-text)_3%,transparent)] px-2.5 py-[7px] has-[[data-card-toggle]:focus-visible]:outline has-[[data-card-toggle]:focus-visible]:outline-1 has-[[data-card-toggle]:focus-visible]:-outline-offset-1 has-[[data-card-toggle]:focus-visible]:outline-focus hover:border-line-strong",
  cardOpen: "border-line-strong",
  cardOpenSlot: "bg-transparent",
  head: "flex min-w-0 items-center gap-2",
  /** The toggle covers the whole summary (a stretched button): a click anywhere opens the card. */
  toggle: "min-w-0 truncate text-left text-[12px] leading-[18px] text-fg outline-none after:absolute after:inset-0 after:content-[''] cursor-pointer",
  chip: "inline-flex h-[18px] shrink-0 items-center rounded-[4px] bg-[color-mix(in_oklab,var(--uhd-text)_8%,transparent)] px-1.5 text-[10px] leading-none text-fg-muted",
  pin: "inline-flex h-4 shrink-0 items-center rounded-[4px] border border-line px-1 text-[10px] leading-none text-fg-muted",
  meta: "mt-[5px] flex min-w-0 items-center gap-1",
  role: "ml-auto shrink-0 text-[10px] leading-none text-fg-faint",
  linked: "mt-[5px] flex min-w-0 items-center gap-1.5 text-[11px] leading-[16px]",
  more: "flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-[3px] px-1 text-left text-[11px] text-fg-muted hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus",
  detail: "mt-2 flex flex-col gap-2.5 border-t border-line-subtle pt-2",
  group: "flex flex-col gap-[3px]",
  button:
    "relative z-10 inline-flex h-6 min-w-0 cursor-pointer items-center gap-1.5 rounded-[4px] border border-line px-2 text-[10.5px] leading-none text-fg hover:bg-hover focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-focus",
  textAction: "relative z-10 inline-flex shrink-0 cursor-pointer items-center gap-1 text-[10.5px] leading-none text-link hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus",
} as const;

/** The pin glyph's colour by kind: power red, signal blue, mechanical grey (theme tokens; swap here). */
export const SLOT_COLOR: Record<SlotKind, string> = {
  power: "var(--uhd-severity-error)",
  signal: "var(--uhd-severity-info)",
  mechanical: "var(--uhd-text-faint)",
};

const STATE_COLOR: Record<SlotState, string> = {
  configured: "var(--uhd-severity-ok)",
  compatible: "var(--uhd-severity-ok)",
  warning: "var(--uhd-severity-warning)",
  incompatible: "var(--uhd-severity-error)",
  unconfigured: "var(--uhd-text-faint)",
};

const STATE_TEXT: Record<SlotState, string> = { configured: "configured", compatible: "compatible", warning: "warning", incompatible: "incompatible", unconfigured: "not configured" };

const SEVERITY = { error: { icon: "circle-x", color: "var(--uhd-severity-error)" }, warning: { icon: "triangle-alert", color: "var(--uhd-severity-warning)" }, info: { icon: "info", color: "var(--uhd-severity-info)" } } as const;

export interface InterfaceCardActions {
  /** Show the interface (or its first link) on the canvas. */
  locate?: (slot: InterfaceSlot) => void;
  /** Select one of its links (or a derived one) by its id on the level. */
  selectLink?: (id: string) => void;
  /** Open the source that declares it (its link's line, else the interface's). */
  openSource?: (slot: InterfaceSlot) => void;
  /** An open slot: start a link from it. */
  connect?: (slot: InterfaceSlot) => void;
  /** A finding's Locate (the host's key), else the slot's own Locate. */
  finding?: (key: string) => void;
  /** A source the interface cites. */
  openLink?: (url: string) => void;
}

/** The pin glyph: one bar per pin (up to four), in the kind's colour; an open slot's are outlined. */
export function SlotGlyph({ kind, pins, open }: { kind: SlotKind; pins: number; open?: boolean }) {
  const n = Math.max(1, Math.min(4, pins || 1));
  const color = SLOT_COLOR[kind];
  return (
    <span
      aria-hidden
      className="inline-flex h-[18px] shrink-0 items-center gap-[2px] rounded-[3px] border px-[3px]"
      style={{ borderColor: open ? "var(--uhd-border)" : `color-mix(in oklab, ${color} 55%, transparent)`, background: "color-mix(in oklab, var(--uhd-text) 5%, transparent)" }}
    >
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="h-[9px] w-[3px] rounded-[1px]" style={open ? { border: "1px solid var(--uhd-text-faint)", width: 3 } : { background: color }} />
      ))}
    </span>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={CARD_LOOK.group} role="group" aria-label={title}>
      <div className={SECTION_LOOK.label}>{title}</div>
      {children}
    </div>
  );
}

/** What an expanded card shows below its summary. */
function CardDetail({ slot, actions }: { slot: InterfaceSlot; actions: InterfaceCardActions }) {
  return (
    <div className={CARD_LOOK.detail} data-card-detail="">
      {slot.pinMap.length > 0 && (
        <Group title="Pin mapping">
          {slot.pinMap.map((p, i) => (
            <div key={`${p.pin}-${i}`} className="flex min-h-5 min-w-0 items-center gap-2 text-[11px] leading-none" data-pin={p.pin}>
              <span className="w-11 shrink-0">
                <span className={CARD_LOOK.pin}>{p.pin}</span>
              </span>
              <span className="w-[88px] shrink-0 truncate text-fg-muted" data-tooltip={p.leaf}>
                {p.leaf ?? ""}
              </span>
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="shrink-0 text-fg" aria-label={p.dir === "←" ? "from" : p.dir === "→" ? "to" : p.dir === "—" ? "shared with" : "with"}>
                  {p.dir}
                </span>
                {p.other ? <span className="shrink-0 text-fg">{p.other}</span> : <span className="text-fg-faint">{p.otherModule ? "" : "not linked"}</span>}
                {p.otherModule && <span className="min-w-0 truncate text-fg-faint">{p.otherModule}</span>}
              </span>
            </div>
          ))}
        </Group>
      )}
      {(slot.protocol || slot.params.length > 0) && (
        <Group title="Protocol and parameters">
          {slot.protocol && (
            <div className={SECTION_LOOK.kv}>
              <span className={SECTION_LOOK.key}>Protocol</span>
              <span className={SECTION_LOOK.value}>{[slot.protocol, slot.role].filter(Boolean).join(" · ")}</span>
            </div>
          )}
          {slot.params.map((p) => (
            <div key={p.label} className={SECTION_LOOK.kv}>
              <span className={SECTION_LOOK.key} data-tooltip={p.label.length > 14 ? p.label : undefined}>
                {p.label}
              </span>
              <span className={SECTION_LOOK.value}>{p.value}</span>
            </div>
          ))}
        </Group>
      )}
      {slot.links.length > 0 && (
        <Group title="Links">
          {slot.links.map((l, i) => (
            <button
              key={`${l.select}-${i}`}
              type="button"
              data-link={l.select}
              onClick={actions.selectLink && (() => actions.selectLink!(l.select))}
              disabled={!actions.selectLink}
              data-tooltip={[l.name, ...l.diagnostics].filter(Boolean).join("\n") || undefined}
              data-tooltip-clamp="4"
              className={cx(
                "relative z-10 flex min-h-5 w-full min-w-0 items-center gap-1.5 rounded-[3px] text-left text-[11px] leading-none",
                actions.selectLink && "cursor-pointer hover:bg-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus",
                l.derived && "pl-3",
              )}
            >
              {l.derived ? (
                <Icon name="corner-down-right" size={11} strokeWidth={1.75} aria-hidden className="shrink-0 text-fg-faint" />
              ) : (
                <span aria-hidden className="size-[7px] shrink-0 rounded-full" style={{ background: STATE_COLOR[l.state] }} />
              )}
              <span className={cx("shrink-0", l.derived ? "text-fg-muted" : "text-fg")}>{l.label}</span>
              <span className="min-w-0 flex-1 truncate text-fg-faint">{l.derived ? "derived" : l.via ? `via ${l.via}` : ""}</span>
              <span className="shrink-0 text-[10px]" style={{ color: STATE_COLOR[l.state] }}>
                {STATE_TEXT[l.state]}
              </span>
            </button>
          ))}
        </Group>
      )}
      <Group title="Findings">
        {slot.findings.length ? (
          slot.findings.map((f, i) => (
            <div key={`${f.code}-${i}`} className="flex min-w-0 items-start gap-2 py-0.5" data-finding={f.code}>
              <Icon name={SEVERITY[f.severity].icon} size={13} strokeWidth={1.75} aria-label={f.severity} className="mt-px shrink-0" style={{ color: SEVERITY[f.severity].color }} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[11px] leading-[1.4] text-fg">{f.message}</span>
                <span className="font-code text-[9.5px] leading-none text-fg-faint">{f.code}</span>
              </span>
              {(f.key && actions.finding) || actions.locate ? (
                <button type="button" className={CARD_LOOK.textAction} onClick={() => (f.key && actions.finding ? actions.finding(f.key) : actions.locate!(slot))}>
                  <Icon name="crosshair" size={11} strokeWidth={1.75} aria-hidden />
                  Locate
                </button>
              ) : null}
            </div>
          ))
        ) : (
          <div className="flex min-h-5 items-center gap-1.5 text-[11px] text-fg-muted">
            <Icon name="circle-check" size={12} strokeWidth={1.75} aria-hidden className="shrink-0 text-ok" />
            No findings for this interface or its links
          </div>
        )}
      </Group>
      {(slot.notes.length > 0 || slot.sources.length > 0) && (
        <Group title="Notes">
          {slot.notes.map((n, i) => (
            <div key={i} className="flex min-w-0 items-start gap-1.5 text-[11px] leading-[1.4]" data-note={n.assumption ? "assumption" : n.label}>
              {n.assumption ? (
                <span className="mt-px inline-flex h-4 shrink-0 items-center rounded-[4px] border border-[color-mix(in_oklab,var(--uhd-severity-warning)_45%,transparent)] px-1 text-[10px] leading-none text-warning">assumption</span>
              ) : (
                <span className="shrink-0 text-fg-faint">{n.label}</span>
              )}
              <span className="min-w-0 text-fg [overflow-wrap:anywhere]">{n.text}</span>
            </div>
          ))}
          {slot.sources.map((s) => (
            <button key={s.url} type="button" className={cx(CARD_LOOK.textAction, "max-w-full self-start")} onClick={() => actions.openLink?.(s.url)} data-tooltip={s.url} disabled={!actions.openLink}>
              <Icon name="file-text" size={12} strokeWidth={1.75} aria-hidden className="shrink-0 text-fg-faint" />
              <span className="truncate">{s.label}</span>
            </button>
          ))}
        </Group>
      )}
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5" role="group" aria-label={`${slot.name} actions`}>
        {actions.locate && (
          <button type="button" className={CARD_LOOK.button} onClick={() => actions.locate!(slot)}>
            <Icon name="crosshair" size={12} strokeWidth={1.75} aria-hidden className="shrink-0 text-fg-muted" />
            Locate on canvas
          </button>
        )}
        {actions.openSource && (
          <button type="button" className={CARD_LOOK.button} onClick={() => actions.openSource!(slot)}>
            <Icon name="file-code" size={12} strokeWidth={1.75} aria-hidden className="shrink-0 text-link" />
            Open in source
          </button>
        )}
        {slot.open && actions.connect && (
          <button type="button" className={CARD_LOOK.button} onClick={() => actions.connect!(slot)}>
            <Icon name="plug" size={12} strokeWidth={1.75} aria-hidden className="shrink-0 text-fg-muted" />
            Connect…
          </button>
        )}
      </div>
    </div>
  );
}

/** One interface as a slot card; it expands in place. */
export function InterfaceCard({ slot, open, onToggle, actions }: { slot: InterfaceSlot; open: boolean; onToggle: () => void; actions: InterfaceCardActions }) {
  const detail = useId();
  const linked = slot.linked[0];
  return (
    <div className={cx(CARD_LOOK.card, open && CARD_LOOK.cardOpen, slot.open && CARD_LOOK.cardOpenSlot)} data-slot={slot.id} data-kind={slot.kind} data-open={open ? "" : undefined}>
      {/* the summary: its toggle covers it (a stretched button), so a click anywhere on it opens the card; the details below are not covered */}
      <div className="relative">
        <div className={CARD_LOOK.head}>
          <SlotGlyph kind={slot.kind} pins={slot.pins.length} open={slot.open} />
          <button
            type="button"
            data-nav=""
            data-card-toggle=""
            aria-expanded={open}
            aria-controls={detail}
            onClick={onToggle}
            onKeyDown={onNavKey}
            className={CARD_LOOK.toggle}
          >
            {slot.name}
          </button>
          <span className="min-w-0 flex-1" />
          {slot.protocol && <span className={cx(CARD_LOOK.chip, slot.open && "opacity-70")}>{slot.protocol}</span>}
          <Icon name="chevron-down" size={13} strokeWidth={1.75} aria-hidden className={cx("shrink-0 text-fg-muted transition-transform duration-100", open && "rotate-180")} />
        </div>
        {(slot.pins.length > 0 || slot.role) && (
          <div className={CARD_LOOK.meta}>
            {slot.pins.slice(0, 8).map((p) => (
              <span key={p} className={CARD_LOOK.pin}>
                {p}
              </span>
            ))}
            {slot.pins.length > 8 && <span className="text-[10px] text-fg-faint">+{slot.pins.length - 8}</span>}
            {slot.role && <span className={CARD_LOOK.role}>{slot.role}</span>}
          </div>
        )}
        {slot.open ? (
          <div className={CARD_LOOK.linked}>
            <span aria-hidden className="size-[11px] shrink-0 rounded-full border border-dashed border-fg-faint" />
            <span className="text-fg-muted">Open slot</span>
            {actions.connect && !open && (
              <button type="button" className={cx(CARD_LOOK.textAction, "ml-auto")} onClick={() => actions.connect!(slot)}>
                Connect…
              </button>
            )}
          </div>
        ) : linked ? (
          <div className={CARD_LOOK.linked}>
            <Icon name="arrow-right" size={12} strokeWidth={1.75} aria-hidden className="shrink-0 text-link" />
            <span className="shrink-0 text-link">{slot.linked.length > 1 ? `${slot.linked.length} modules` : linked.module}</span>
            {linked.via && <span className="min-w-0 truncate text-fg-faint">via {linked.via}</span>}
            {slot.state && slot.state !== "configured" && slot.state !== "compatible" && (
              <span aria-label={STATE_TEXT[slot.state]} className="ml-auto size-[7px] shrink-0 rounded-full" style={{ background: STATE_COLOR[slot.state] }} />
            )}
          </div>
        ) : slot.usedBy ? (
          <div className={CARD_LOOK.linked}>
            <Icon name="corner-down-right" size={12} strokeWidth={1.75} aria-hidden className="shrink-0 text-fg-faint" />
            <span className="min-w-0 truncate text-fg-faint">in use through {slot.usedBy}</span>
          </div>
        ) : null}
      </div>
      <div id={detail} hidden={!open}>
        {open && <CardDetail slot={slot} actions={actions} />}
      </div>
    </div>
  );
}

/** The cards, the first few shown; "N more · names" opens the rest. */
export function InterfaceCards({ slots, actions, first = 4 }: { slots: InterfaceSlot[]; actions: InterfaceCardActions; first?: number }) {
  const [expanded, toggle] = useExpandedCards();
  const [all, setAll] = useState(false);
  // an expanded card is never hidden behind "more"
  const lastOpen = slots.reduce((m, s, i) => (expanded.has(s.id) ? i : m), -1);
  const cut = all ? slots.length : Math.max(first, lastOpen + 1);
  const shown = slots.slice(0, cut);
  const rest = slots.slice(cut);
  return (
    <div className={CARD_LOOK.list} data-interface-cards="">
      {shown.map((s) => (
        <InterfaceCard key={s.id} slot={s} open={expanded.has(s.id)} onToggle={() => toggle(s.id)} actions={actions} />
      ))}
      {rest.length > 0 && (
        <button type="button" data-nav="" onKeyDown={onNavKey} className={CARD_LOOK.more} aria-expanded={false} onClick={() => setAll(true)} data-tooltip={rest.map((s) => s.name).join(", ")} data-tooltip-clamp="4">
          <Icon name="chevron-right" size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
          <span className="min-w-0 truncate">
            {rest.length} more · {rest.map((s) => s.name).join(", ")}
          </span>
        </button>
      )}
    </div>
  );
}
