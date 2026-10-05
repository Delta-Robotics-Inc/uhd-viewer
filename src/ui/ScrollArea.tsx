/**
 * The one scroll container: Radix ScrollArea with thin, auto-hiding,
 * themed scrollbars. Never a default browser scrollbar (PB-900).
 */
import * as Radix from "@radix-ui/react-scroll-area";
import { forwardRef, type ReactNode } from "react";
import { cx } from "./cx";

export interface ScrollAreaProps {
  children?: ReactNode;
  /**
   * Classes of the root. It is a flex column, so a height (a flex child with
   * min-h-0) or a max height (`max-h-64`) is all the scrolled viewport needs.
   */
  className?: string;
  /** Classes of the scrolled viewport's content wrapper. */
  contentClassName?: string;
  /** Which bars to offer (default vertical). */
  axis?: "vertical" | "horizontal" | "both";
  /** `hover` shows the bars while the pointer is over the area; `scroll` only while scrolling (default hover). */
  type?: "hover" | "scroll" | "auto" | "always";
}

function Bar({ orientation }: { orientation: "vertical" | "horizontal" }) {
  return (
    <Radix.Scrollbar
      orientation={orientation}
      className={cx(
        "uhd-scrollbar flex touch-none select-none p-px transition-opacity duration-150 ease-out data-[state=hidden]:opacity-0",
        orientation === "vertical" ? "h-full w-2" : "h-2 flex-col",
      )}
    >
      <Radix.Thumb className="relative flex-1 rounded-full bg-thumb hover:bg-thumb-hover before:absolute before:top-1/2 before:left-1/2 before:size-full before:min-h-6 before:min-w-6 before:-translate-1/2 before:content-['']" />
    </Radix.Scrollbar>
  );
}

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea({ children, className, contentClassName, axis = "vertical", type = "hover" }, ref) {
  return (
    <Radix.Root type={type} scrollHideDelay={500} className={cx("uhd-scroll relative flex flex-col overflow-hidden", className)}>
      <Radix.Viewport ref={ref} className={cx("min-h-0 w-full flex-1 rounded-[inherit]", axis === "vertical" && "uhd-scroll-y")}>
        <div className={contentClassName}>{children}</div>
      </Radix.Viewport>
      {axis !== "horizontal" && <Bar orientation="vertical" />}
      {axis !== "vertical" && <Bar orientation="horizontal" />}
      <Radix.Corner />
    </Radix.Root>
  );
});
