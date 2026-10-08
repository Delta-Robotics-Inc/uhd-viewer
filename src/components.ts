/**
 * The component library (`@deltarobotics/uhd-viewer/components`): the
 * viewer's views of a UHD bundle as React components, for hosts that build
 * their own shell. No app chrome: the shell places the views, its own header,
 * tabs and panels.
 *
 *   <ThemeProvider adapter={vscodeThemeAdapter()}>
 *     <UhdViewer bundleUrl="/uhd-bundle.json" host={host}>
 *       <DiagramCanvas />
 *       <ViewerInspector />
 *     </UhdViewer>
 *   </ThemeProvider>
 *
 * React, React DOM, Three, React Flow and Radix are peer dependencies here
 * (one copy each in the host's bundle). The stylesheet is
 * `@deltarobotics/uhd-viewer/components.css`; a host's own Tailwind build
 * gets the token utilities from `@deltarobotics/uhd-viewer/tailwind-theme.css`.
 * Nothing here names a host product.
 */
import "./styles/index.css";

// ---- the host contract (unchanged from mountViewer's)
export type * from "./api";
export { renderViewer } from "./viewer/mount";
export { parseHostMessage, isViewerEvent, originAllowed, PREFIX as HOST_MESSAGE_PREFIX } from "./host/protocol";

// ---- the model and its state
export { UhdViewer, ViewerBoundary, ViewerProvider, useViewer, useViewerSource, useViewerController, type AppProps as UhdViewerOptions, type UhdViewerProps, type HostLink, type ViewerController } from "./viewer/controller";
export type { LoadedSource } from "./source/source";
export { tolerantSystem, isPlaceholder, type MissingDefinition, type LeftOut, type TolerantSystem } from "./source/tolerant";
export type { Classification } from "./model/classification";
export { CLASSIFICATIONS, colorFor, legendFor, classKey, type LegendEntry } from "./model/classification";
export { isolate, presentKeys, linkKeys, toggleIsolated, type Isolation } from "./model/isolate";
export type { ViewModel, ViewNode, ViewLink } from "./model/types";
export type { Selection } from "./canvas/Canvas";
export type { Panel, Goto } from "./chrome/Chrome";

// ---- views
export { DiagramCanvas, DiagramToolbar, DiagramLegend, DiagramLegendItems, IsolationClear, MissingNotice, ScenarioBanner, Scene3D, ViewerInspector, ViewerNodeMenu, CLASSIFICATION_OPTIONS, DETAIL_OPTIONS, type DiagramCanvasProps, type Scene3DProps } from "./viewer/views";
export { ModelView, type ModelViewProps, type ModelInfo } from "./cad/ModelView";

// ---- primitives
export { ScrollArea, type ScrollAreaProps } from "./ui/ScrollArea";
export { Toolbar, ToolbarSeparator, IconButton, ToggleGroup, type ToolbarProps, type IconButtonProps, type ToggleGroupProps } from "./ui/Toolbar";
export { Legend, LegendItem, type LegendItemProps } from "./ui/Legend";
export { InspectorPanel, Section, PropertyRow, Badge, StatusDot, EmptyState, type InspectorPanelProps, type Tone } from "./ui/Inspector";
export { Tooltips } from "./ui/Tooltips";
export { Icon } from "./canvas/Icon";
export { cx } from "./ui/cx";

// ---- theming
export {
  TOKEN_NAMES,
  tokenVar,
  token,
  mix,
  defineTheme,
  applyTheme,
  readToken,
  themeCss,
  themeDeclarations,
  DERIVED,
  type Theme,
  type ThemeTokens,
  type ThemeToken,
  type ThemeScheme,
} from "./theme/tokens";
export { defaultDark, defaultLight, defaultTheme, DRC_TOKENS, DARK_DATA_TOKENS, LIGHT_DATA_TOKENS } from "./theme/themes";
export { staticTheme, defaultThemeAdapter, vscodeThemeAdapter, vscodeTheme, vscodeScheme, pickTheme, type ThemeAdapter } from "./theme/adapters";
export { ThemeProvider, useTheme, tokenColor, type ThemeProviderProps, type ThemeState } from "./theme/ThemeProvider";
export { resolveTheme, completeTheme } from "./theme/resolve";
