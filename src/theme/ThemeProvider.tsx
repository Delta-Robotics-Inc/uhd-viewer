/**
 * Puts a theme on the viewer's root element and tells the components that
 * draw outside CSS (the 3D scene) when it changes. Everything rendered inside
 * reads the tokens as CSS variables; popovers portal into the same root so
 * they keep them.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { applyTheme, tokenVar, type Theme, type ThemeToken } from "./tokens";
import { defaultThemeAdapter, type ThemeAdapter } from "./adapters";
import { Tooltips } from "../ui/Tooltips";

export interface ThemeState {
  theme: Theme;
  /** The themed element: tooltips and menus portal here so they keep the tokens. */
  root: HTMLElement | null;
}

const ThemeContext = createContext<ThemeState>({ theme: defaultThemeAdapter("dark").current(), root: null });

/** The current theme and the themed root element. */
export const useTheme = () => useContext(ThemeContext);

export interface ThemeProviderProps {
  /** Where the theme comes from (default: the viewer's own, following the system). */
  adapter?: ThemeAdapter;
  /** Or one theme (wins over `adapter`). */
  theme?: Theme;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/** The themed root: a full-size element carrying the tokens. */
export function ThemeProvider({ adapter, theme: fixed, className, style, children }: ThemeProviderProps) {
  const source = useMemo(() => adapter ?? defaultThemeAdapter(), [adapter]);
  const [theme, setTheme] = useState<Theme>(() => fixed ?? source.current());
  useEffect(() => {
    if (fixed) return setTheme(fixed);
    setTheme(source.current());
    return source.subscribe?.(setTheme);
  }, [source, fixed]);
  const ref = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setRoot(el);
    return applyTheme(el, theme);
  }, [theme]);
  const value = useMemo(() => ({ theme, root }), [theme, root]);
  return (
    <ThemeContext.Provider value={value}>
      <div ref={ref} className={`uhd-root${className ? ` ${className}` : ""}`} style={style}>
        {children}
        <Tooltips root={root} />
      </div>
    </ThemeContext.Provider>
  );
}

let probe: CanvasRenderingContext2D | null | undefined;

/**
 * A token's colour as `#rrggbb` (alpha dropped), resolved on `element`:
 * for canvases that cannot read CSS variables or modern colour syntax
 * (`oklch()`, `color-mix()`), like the 3D scene's background and grid.
 */
export function tokenColor(element: Element | null, name: ThemeToken, fallback = "#1a1a1a"): string {
  if (!element || typeof document === "undefined") return fallback;
  const span = document.createElement("span");
  span.style.color = `var(${tokenVar(name)})`;
  span.style.display = "none";
  element.appendChild(span);
  const css = getComputedStyle(span).color;
  span.remove();
  if (!css) return fallback;
  if (probe === undefined) probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!probe) return fallback;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "#000";
  probe.fillStyle = css;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
