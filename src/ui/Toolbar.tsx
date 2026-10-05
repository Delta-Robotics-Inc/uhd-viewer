/**
 * Toolbar primitives: a floating card of icon buttons, each naming itself in
 * a tooltip (no text toolbars). Toggles show their state with an accent wash,
 * an accent outline and `aria-pressed`; a high-contrast theme outlines them
 * instead.
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Icon } from "../canvas/Icon";
import { cx } from "./cx";

export interface ToolbarProps {
  children?: ReactNode;
  className?: string;
  orientation?: "horizontal" | "vertical";
  /** For assistive technology ("Diagram tools"). */
  label?: string;
}

/** A floating card holding icon buttons and separators. */
export function Toolbar({ children, className, orientation = "horizontal", label }: ToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      aria-orientation={orientation}
      className={cx(
        "uhd-toolbar flex items-center gap-1 rounded-panel border border-line bg-surface p-1 shadow-float outline outline-1 -outline-offset-1 outline-contrast",
        orientation === "vertical" ? "flex-col" : "flex-row",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function ToolbarSeparator({ orientation = "vertical" }: { orientation?: "vertical" | "horizontal" }) {
  return <span aria-hidden className={cx("shrink-0 bg-line", orientation === "vertical" ? "mx-0.5 h-5 w-px" : "my-0.5 h-px w-5")} />;
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** A Lucide icon name (kebab-case), or the icon itself. */
  icon: string | ReactNode;
  /** What the button does: its tooltip and accessible name. */
  label: string;
  /** A toggle's state (absent: a plain action). */
  pressed?: boolean;
  shortcut?: string;
  tooltipSide?: "top" | "bottom" | "left" | "right";
  size?: "sm" | "md";
  /** A count or dot over the icon (errors on a checks button). */
  badge?: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, pressed, shortcut, tooltipSide, size = "md", badge, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      data-tooltip={label}
      data-tooltip-shortcut={shortcut}
      data-tooltip-side={tooltipSide}
      className={cx(
        "uhd-icon-button relative grid shrink-0 cursor-pointer place-items-center rounded-md border border-transparent text-fg-muted transition-colors duration-100",
        "hover:bg-active hover:text-fg hover:outline hover:outline-1 hover:outline-dashed hover:-outline-offset-1 hover:outline-contrast-active",
        "focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-focus",
        "disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent",
        "aria-pressed:border-accent/45 aria-pressed:bg-accent-tint aria-pressed:text-accent aria-pressed:hover:bg-accent-tint aria-pressed:hover:text-accent",
        "aria-pressed:outline aria-pressed:outline-1 aria-pressed:-outline-offset-1 aria-pressed:outline-contrast-active",
        size === "sm" ? "size-7" : "size-8",
        className,
      )}
      {...rest}
    >
      {typeof icon === "string" ? <Icon name={icon} size={size === "sm" ? 14 : 16} strokeWidth={1.75} aria-hidden /> : icon}
      {badge !== undefined && badge !== null && badge !== false && (
        <span className="absolute -top-0.5 -right-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-error px-0.5 text-[9px] leading-none font-semibold text-white">{badge}</span>
      )}
    </button>
  );
});

export interface ToggleGroupProps<T extends string> {
  /** The choices, each an icon with a label for its tooltip. */
  options: readonly { id: T; icon: string | ReactNode; label: string; disabled?: boolean }[];
  value: T;
  onChange: (value: T) => void;
  label?: string;
  tooltipSide?: IconButtonProps["tooltipSide"];
  size?: IconButtonProps["size"];
}

/** One of several, as icon buttons side by side. */
export function ToggleGroup<T extends string>({ options, value, onChange, label, tooltipSide, size }: ToggleGroupProps<T>) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-0.5">
      {options.map((o) => (
        <IconButton
          key={o.id}
          icon={o.icon}
          label={o.label}
          pressed={o.id === value}
          disabled={o.disabled}
          tooltipSide={tooltipSide}
          size={size}
          onClick={() => onChange(o.id)}
        />
      ))}
    </div>
  );
}
