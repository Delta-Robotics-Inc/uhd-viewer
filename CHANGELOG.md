# Changelog

All notable changes to **uhd-viewer** (`@deltarobotics/uhd-viewer`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
