/**
 * Artifacts as cards: a picture (the image itself, a model's preview, else
 * the kind's icon), the title, the kind and where it comes from. A click
 * opens the artifact: through the host when it takes artifacts, else its URL
 * in a new tab. Pictures load lazily (only cards scrolled into view); a model
 * is drawn only when the host gives a drawer for it.
 *
 * The grid is a container: two or more cards a row where they fit, and one
 * card a row, picture at the left, in a narrow panel (the layout is in
 * styles/ui.css; see there why it is not container-variant utilities).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ArtifactCardModel, ArtifactPreview } from "../model/artifacts";
import { groupArtifactCards } from "../model/artifacts";
import { Icon } from "../canvas/Icon";
import { useHost } from "../host/context";
import { cx } from "../ui/cx";

/** Calls `onSeen` once, when the element first comes near the visible part of its scroller. */
function useSeen<T extends HTMLElement>(enabled: boolean): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || seen || !el) return;
    if (typeof IntersectionObserver === "undefined") return setSeen(true);
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: "160px" });
    io.observe(el);
    return () => io.disconnect();
  }, [enabled, seen]);
  return [ref, seen];
}

function Picture({ preview, icon, alt }: { preview?: ArtifactPreview; icon: string; alt: string }) {
  const { drawModel } = useHost();
  const [failed, setFailed] = useState(false);
  const [drawn, setDrawn] = useState<string>();
  const wantsModel = preview?.kind === "model" && Boolean(drawModel);
  const [ref, seen] = useSeen<HTMLSpanElement>(wantsModel);
  const src = preview?.kind === "model" ? preview.src : undefined;
  useEffect(() => {
    if (!seen || !src || !drawModel) return;
    let cancelled = false;
    setDrawn(undefined);
    drawModel(src).then(
      (png) => !cancelled && setDrawn(png),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [seen, src, drawModel]);
  useEffect(() => setFailed(false), [preview?.src]);
  const image = !failed && preview?.kind === "image" ? preview.src : undefined;
  const shown = image ?? (!failed ? drawn : undefined);
  return (
    <span
      ref={ref}
      data-artifact-picture={shown ? (image ? "image" : "model") : "icon"}
      className={cx(
        // its size is the grid's to say (styles/ui.css): a picture over the text, or a square at its left in a narrow panel
        "uhd-artifact-picture relative grid shrink-0 place-items-center overflow-hidden",
        // a picture sits on the preview matte (photos and drawings are made for a light page); an icon on a quiet wash
        image ? "bg-[var(--uhd-preview)]" : "bg-[color-mix(in_oklab,var(--uhd-text)_5%,transparent)]",
      )}
    >
      {shown ? (
        <img src={shown} alt={alt} loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} className="absolute inset-0 size-full object-contain p-[6%]" />
      ) : (
        <Icon name={icon} size={22} strokeWidth={1.5} className="text-fg-muted" aria-hidden />
      )}
    </span>
  );
}

export interface ArtifactCardProps {
  card: ArtifactCardModel;
  /** Shown at the card's top right (a "sample" tag, a state). */
  badge?: ReactNode;
}

/** One artifact: its picture, title, kind and source. */
export function ArtifactCard({ card, badge }: ArtifactCardProps) {
  const { openArtifact, openLink } = useHost();
  const open = card.artifactId && openArtifact ? () => openArtifact(card.defId, card.artifactId!) : card.href && openLink && (card.remote || !card.artifactId) ? () => openLink(card.href!) : undefined;
  const inert = !open && !card.href;
  const tip = [card.title, card.description, card.location].filter(Boolean).join("\n");
  return (
    <a
      className={cx(
        "uhd-artifact-card group relative overflow-hidden rounded-[6px] border border-line bg-raised text-left text-fg no-underline",
        "outline-1 -outline-offset-1 outline-contrast transition-colors",
        inert ? "cursor-default" : "cursor-pointer hover:border-line-strong hover:outline-dashed hover:outline-contrast-active",
        "focus-visible:border-focus focus-visible:outline-solid focus-visible:outline-focus",
      )}
      href={open ? undefined : card.href}
      target="_blank"
      rel="noreferrer"
      role={open ? "button" : undefined}
      tabIndex={inert ? -1 : 0}
      title={tip}
      aria-label={`${card.title}: ${card.kindLabel}${card.source ? `, ${card.source}` : ""}`}
      data-artifact={card.artifactId}
      data-artifact-kind={card.kind}
      onClick={
        open &&
        ((e) => {
          e.preventDefault();
          open();
        })
      }
      onKeyDown={
        open &&
        ((e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        })
      }
    >
      <Picture preview={card.preview} icon={card.icon} alt={card.title} />
      <span className="uhd-artifact-text flex min-w-0 flex-1 flex-col justify-center gap-px border-line px-2 py-1.5">
        <span className="line-clamp-2 font-ui text-[11px] leading-[1.3] break-words text-fg">{card.title}</span>
        <span className="flex min-w-0 items-center gap-1 font-label text-[9px] leading-[1.4] tracking-[0.06em] text-fg-muted uppercase">
          <span className="truncate">{card.kindLabel}</span>
          {card.format && !card.kindLabel.toUpperCase().includes(card.format) && <span className="shrink-0 text-fg-faint">· {card.format}</span>}
        </span>
        {(card.source || card.sourceNote) && (
          <span className="flex min-w-0 items-center gap-1 font-ui text-[9.5px] leading-[1.4] text-fg-muted">
            <Icon name={card.remote ? "globe" : "file"} size={9} strokeWidth={1.75} className="shrink-0" aria-hidden />
            <span className="truncate">{[card.source, card.sourceNote].filter(Boolean).join(" · ")}</span>
          </span>
        )}
      </span>
      {badge && <span className="absolute top-1 right-1">{badge}</span>}
    </a>
  );
}

/** Cards in a grid that fits its container. */
export function ArtifactGrid({ cards, className }: { cards: ArtifactCardModel[]; className?: string }) {
  if (!cards.length) return null;
  return (
    <div className={cx("uhd-artifact-grid mb-2", className)}>
      <div className="uhd-artifact-grid-cards">
        {cards.map((c) => (
          <ArtifactCard key={c.key} card={c} />
        ))}
      </div>
    </div>
  );
}

/** Cards under a small title per group (Images, 3D models, Datasheets, …), each with its count. */
export function ArtifactCards({ cards, className }: { cards: ArtifactCardModel[]; className?: string }) {
  const groups = groupArtifactCards(cards);
  if (!groups.length) return null;
  return (
    <div className={cx("uhd-artifact-cards", className)}>
      {groups.map((g) => (
        <div key={g.id} data-artifact-group={g.id}>
          <div className="pt-1 pb-1.5 font-label text-[9.5px] leading-none tracking-[0.08em] text-fg-muted uppercase">
            {g.title} · {g.cards.length}
          </div>
          <ArtifactGrid cards={g.cards} />
        </div>
      ))}
    </div>
  );
}
