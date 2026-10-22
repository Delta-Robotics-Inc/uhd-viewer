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
export { initialInteraction, interactionReducer, interactionProps, canvasCommand, applySelectChanges, firstView, TOOL_OPTIONS, type CanvasTool, type InteractionState, type InteractionAction, type CanvasCommand, type Viewport } from "./canvas/interaction";
export { openAction } from "./viewer/controller";
export { cardWidth, labelIsCut, CARD_W, CARD_W_MAX } from "./layout/card-body";
export { DiagramCanvas, DiagramToolbar, ToolToggle, ViewButtons, DiagramLegend, DiagramLegendBody, DiagramLegendItems, FittedLegend, LegendToolbarButton, IsolationClear, MissingNotice, ScenarioBanner, Scene3D, ViewerInspector, ViewerNodeMenu, CLASSIFICATION_OPTIONS, DETAIL_OPTIONS, type DiagramCanvasProps, type Scene3DProps } from "./viewer/views";
export { ModelView, type ModelViewProps, type ModelInfo } from "./cad/ModelView";
// the module tree, docked at the left of the view (PB-1042), and its model
export { ViewerHierarchy, HierarchyToggle, RAIL_WIDTH, HIERARCHY_LOOK, type ViewerHierarchyProps, type HierarchyCommand } from "./viewer/hierarchy";
export {
  buildHierarchy,
  filterHierarchy,
  visibleRows,
  treeKey,
  selectedPath,
  rowTarget,
  drillInto,
  revealPaths,
  ancestorsOf,
  hierarchyIndex,
  walkHierarchy,
  panelState,
  groupWiring,
  markLegend,
  WIRING_PATH,
  kindOf,
  KIND_ICON,
  KIND_LABEL as HIERARCHY_KIND_LABEL,
  HIERARCHY_WIDTH,
  type HierarchyNode,
  type HierarchyKind,
  type HierarchyRow,
  type HierarchyPanelState,
  type HierarchyOptions,
  type TreeKeyResult,
} from "./model/hierarchy";
// the inspector's details on their own, for a host with an inspector of its own
export { SelectionDetails, type SelectionDetailsProps, type DetailsTarget } from "./viewer/details";
export { ArtifactCard, ArtifactCards, ArtifactGrid, type ArtifactCardProps } from "./chrome/ArtifactCards";
export { EvidenceSection } from "./chrome/Evidence";
export { artifactCard, artifactCards, mergeFormats, isInternalArtifact, classifyArtifact, evidenceSourceCards, groupArtifactCards, ARTIFACT_GROUPS, type ArtifactCardModel, type ArtifactCardOptions, type ArtifactGroup, type ArtifactKind, type ArtifactPreview, type ArtifactSourceRow } from "./model/artifacts";
export type { EvidenceFiles, SourceRow, Verification } from "./model/evidence";
export { HostContext, type HostActions } from "./host/context";

// ---- primitives
export { ScrollArea, type ScrollAreaProps } from "./ui/ScrollArea";
export { Toolbar, ToolbarSeparator, IconButton, ToggleGroup, type ToolbarProps, type IconButtonProps, type ToggleGroupProps } from "./ui/Toolbar";
export { Legend, LegendItem, LegendSwatches, type LegendItemProps, type LegendProps } from "./ui/Legend";
export { legendStage, legendRoom, type LegendStage } from "./ui/legendFit";
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
