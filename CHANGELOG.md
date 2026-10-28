# Changelog

All notable changes to **uhd-viewer** (`@deltarobotics/uhd-viewer`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **An empty level can offer a way to add a part.** `DiagramCanvas` takes `emptyAction` (`{ label, onClick }`): a level with no modules then shows a 192 px dashed box with a large plus and the label under it, a button (a host's parts library, for instance). Without it the level says it has no modules, as before.
- **The legend folds to a tab at the right edge**: a chevron and a dot per colour on the level (`LegendTab`). `FittedLegend` folds and opens it (`open`, `onOpenChange` and `defaultOpen`; `LegendFold` is the fold button for a legend's header), and folds it by itself on a canvas under 500 px tall until it is opened there (`legendFolded`, `LEGEND_SHORT`).
- **Each legend entry says what it stands for** in a second line ("Electrical, Power and signals"): `LegendEntry.meaning`, `LegendItem`'s `meaning`.

### Changed

- **The legend sits at the bottom right**, left of a floating inspector when one is open; the bottom left is the hierarchy's. It still gives way to the toolbar as the canvas narrows (compact, then the toolbar's button). Its names are in title case.
- **The context menu reads like a menu**: 12 px title case, a 14 px icon per item and its key at the right (Fit view F, Select all Ctrl+A, Pan tool H). A module's menu has Copy path; the empty canvas's menu adds Inspect, Open in new tab, Open source and Copy path for the module selected (`NodeMenuItem` takes `icon`, `shortcut` and `separator`).
- **Tooltips are labels** ("Select", "Pan", "Reset layout", "Isolate"), and open after 250 ms.

- **The hierarchy panel floats.** `ViewerHierarchy` is a card like a host's header: 4 px from the view's edges and below the header, with the panel radius, a border all round and the panel shadow. The canvas starts beside it. It slides open and folded in 200 ms (none with reduced motion), and the 36 px folded rail with its vertical label is gone.
- **The hierarchy folds from inside the panel.** Its header has a Hide hierarchy button. Folded, it leaves one icon-only button floating at the card's top left, below the header, that opens it again (Show hierarchy): the icon alone over the canvas, with no border, face or shadow of its own, that takes a soft rounded fill and a faint glow in the theme's toolbar hover colour on hover. The button takes none of the view's width (`RAIL_WIDTH` is 0), and the keyboard moves between the two buttons as the panel folds and opens. A host's `open`, `close` and `toggle` commands work as before.
- **The inspector lists every interface** of a module, not only those on its outline. A pin bound into another interface comes last and says which one ("part of UART2").
- **Long lists show ten at a time**: the interface cards and a module's parameters have "Show 10 more" and "Show fewer" (`useLoadMore`, exported from `components`).
- **A long description is cut to five lines**, with More and Less (`ClampedText`).
- **A parent's Artifacts section shows its own artifacts only**: no row of its parts to pick from, and its count is its own.
- **The hierarchy's group of harnesses, cables and fastener stacks is called "Harnesses & links"** (it was "Wiring & hardware").
- **"Harnesses & links" shows the level on screen only.** The group lists the harnesses, cables and fastener stacks of the level the diagram shows, not those of the modules inside it, and its count is theirs; a click on one frames it on that level. Drilling into a module shows its own. `groupWiring` takes the level (`groupWiring(tree, level)`); without it, it groups every harness as before.

### Deprecated

- `HierarchyToggle`, a header button for the panel: the panel brings its own controls, so a host needs none. It will be removed in a later minor release.

### Fixed

- **A harness drawn along its lines is focused like a module.** A harness with no card of its own (a cable between two parts, or hardware that links name) is selected as the line that carries its name tab, and its lines are framed, when its row in the hierarchy is clicked, when a host focuses it (`uhd-viewer:focus`), and when a host's `uhd-viewer:select` names it by its path (a finding's Locate). Its row is highlighted while one of its lines is selected. In the 3D view a routed harness focused or selected by its path is selected as itself.
- **The pin mapping fits a narrow inspector.** Its rows share columns that fit the card: a long pin or interface name (a mechanical interface's "ESC mount") ends in an ellipsis with its full name in the tooltip, instead of wrapping over the next row, and the leaf column shows only when a pin binds one.
- **The model view's card no longer covers the model** (`ModelView`). The name and size are behind a Model info button in the toolbar (`infoOpen` shows them from the start), and nothing in the view selects as text: a drag that starts on the card turns the model, and Select All no longer lights the card up. The 3D view's caption and the tooltips are not selectable either.

## [0.2.0] — 2026-10-25

The first public release, and the first on npmjs. The 0.1.x versions were built with the Protoboard stack and never published to npmjs; this section summarises what changed since them.

### Added

- **Open source.** The viewer is under the Apache License 2.0 (`LICENSE`, `NOTICE`). Contributions are welcome with a Developer Certificate of Origin sign-off and no CLA (`CONTRIBUTING.md`, `DCO`). `TRADEMARKS.md` says how the Protoboard name and logo may be used.
- **UHD 0.3.0.** The viewer reads UHD 0.3.0 bundles: an export may be a net port, and a module may be marked as a board.
- **A hierarchy panel** (`ViewerHierarchy`): the whole module tree, docked at the left of the view and kept in step with the canvas. A click selects a module, a double-click opens it, and you can type to filter it. It folds, resizes, works from the keyboard as a tree, and stays within its view's width.
- **A new inspector layout**: sections with clear headers, and cards for interfaces that expand to show their pins. Alike interfaces share one card ("Motor pads ×4"), power comes before signal, and an exported interface says what it is exported as.
- **Automatic layout that reads better.** A level of modules is laid out as a block rather than one long row, in reading order. A proposed layout replaces a saved one only when it is clearly better. Layout metrics and the layout itself are available without a browser from `@deltarobotics/uhd-viewer/headless`.
- **The 3D view borrows placement.** A module with no assembly of its own is shown in the nearest assembly above it, and the view says where the placement comes from.
- **Canvas controls**: right-drag pans (a right-click without a drag still opens the menu); Space-drag pans from over a module too.
- **The legend makes way**: on a small view it shrinks to a compact form, then to a toolbar button.

### Changed

- Labels and headers use bold Kode Mono (SIL Open Font License, shipped with its licence text) in place of the earlier commercial face.
- Shorter interface text throughout, and an empty level says what to do in one line.
- A module picked again while it is selected is reported to the host again, so a host's inspector comes back each time.
- Viewports a host gives after the viewer has started are applied.

### Security

- `uhd-viewer serve` sends every artifact with a sandboxing content security policy and `X-Content-Type-Options: nosniff`, and an HTML artifact is downloaded rather than shown, so a file in a bundle cannot run script on the viewer's origin.

### Packaging

- The package is public on npmjs with provenance, released from a tag by `.github/workflows/release.yml`. It carries `LICENSE`, `NOTICE` and the font licence.

## 0.1.0 – 0.1.4 — 2026-09-26 to 2026-10-11

Built and published with the Protoboard stack only, not on npmjs. In brief: the system diagram (modules, interfaces, links routed orthogonally, harnesses, bundles that open into their conductors, domain, DRC and signal classifications, the pair view, system checks and fault scenarios); boards, nets and enclosures; the 3D view assembled from UHD's mechanical links, with exploded and section views and callout labels; the viewer as a library (`mountViewer`), a React component library with token theming (a VS Code adapter included), and `uhd-viewer serve`; the host message protocol (focus, select, drill, set view, and the events back); marks on modules; isolating a legend entry; artifacts as cards in the inspector; and the select and pan tools with a selection box and keys.
