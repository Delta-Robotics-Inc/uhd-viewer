/**
 * Artifacts as cards (model/artifacts.ts) and the inspector's details on
 * their own (viewer/details.tsx): every artifact of a definition is one card
 * with its kind and source, a host says which pictures may load, and a host's
 * own inspector shows a module, a link or a definition as the viewer's does.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ArtifactDef, ModuleDef } from "@uhd/types/index.js";
import type { UhdBundle } from "@uhd/types/bundle.js";
import { artifactCards, classifyArtifact, evidenceSourceCards, groupArtifactCards, hostOf } from "../src/model/artifacts";
import { SelectionDetails } from "../src/viewer/details";
import fixture from "../fixtures/imu-pod/uhd-bundle.json";

const bundle = fixture as unknown as UhdBundle;
const art = (a: Partial<ArtifactDef> & { id: string }): ArtifactDef => ({ name: a.id, type: "documentation", ...a }) as ArtifactDef;
const part = (artifacts: ArtifactDef[]): ModuleDef => ({ id: "part", name: "Part", kind: "module", interfaces: [], artifacts }) as unknown as ModuleDef;
const files = (defId: string, path: string) => `file:///${defId}/${path}`;

describe("artifact cards", () => {
  const def = part([
    art({ id: "ds", name: "Datasheet rev 6", type: "datasheet", url: "https://www.analog.com/media/DS18B20.pdf" }),
    art({ id: "page", name: "Product page", url: "https://www.adafruit.com/product/381" }),
    art({ id: "photo", name: "Photo", url: "https://cdn-shop.adafruit.com/970x728/381-02.jpg?v=3" }),
    art({ id: "thumb", name: "Thumbnail", type: "image" as ArtifactDef["type"], filePath: "img/part.png", tags: ["thumbnail"] }),
    art({ id: "src", name: "Generator", type: "cad", role: "source", format: "py", filePath: "cad/part.py" }),
    art({ id: "step", name: "Part (STEP)", type: "3d_model", role: "body", format: "step", filePath: "cad/part.step", provenance: { tool: "build123d 0.13.0" } as ArtifactDef["provenance"] }),
    art({ id: "glb", name: "Part (GLB)", type: "3d_model", role: "body", format: "glb", filePath: "cad/part.glb" }),
    art({ id: "if_usb", name: "usb geometry", type: "3d_model", role: "interface", format: "glb", filePath: "cad/interfaces/usb.glb", interfaceId: "usb" }),
    art({ id: "manifest", name: "Manifest", type: "cad", role: "source", format: "json", filePath: "cad/part.manifest.json" }),
    art({ id: "sch", name: "Schematic", type: "schematic", format: "svg", filePath: "out/schematic.svg" }),
    art({ id: "top", name: "PCB top", type: "pcb", format: "svg", filePath: "out/pcb-top.svg" }),
    art({ id: "lid", name: "Lid", type: "cad", role: "body", format: "stl", filePath: "out/lid.stl", tags: ["print"] }),
    art({ id: "cut", name: "Plate", type: "cad", role: "drawing", format: "dxf", filePath: "out/plate.dxf" }),
    art({ id: "fw", name: "Firmware", type: "firmware" as ArtifactDef["type"], url: "https://github.com/x/y/releases" }),
    art({ id: "nothing", name: "No file" }),
  ]);

  it("makes one card of every artifact that has a file or an address, none left out", () => {
    const cards = artifactCards(def, files);
    expect(cards).toHaveLength(14);
    expect(new Set(cards.map((c) => c.artifactId)).size).toBe(14);
    expect(groupArtifactCards(cards).map((g) => [g.id, g.cards.map((c) => c.artifactId)])).toEqual([
      ["images", ["photo", "thumb"]],
      ["models", ["step", "glb"]],
      ["board", ["top", "sch"]],
      ["datasheets", ["ds"]],
      ["documents", ["page"]],
      ["design", ["src", "lid", "cut", "fw"]],
      ["data", ["if_usb", "manifest"]],
    ]);
  });

  it("says what each is and where it comes from", () => {
    const by = Object.fromEntries(artifactCards(def, files).map((c) => [c.artifactId, c]));
    expect(by.ds).toMatchObject({ kind: "datasheet", kindLabel: "Datasheet", format: "PDF", source: "analog.com", remote: true, href: "https://www.analog.com/media/DS18B20.pdf" });
    expect(by.page).toMatchObject({ kind: "document", kindLabel: "Web page", source: "adafruit.com" });
    expect(by.step).toMatchObject({ kind: "model", kindLabel: "STEP model", source: "part.step", sourceNote: "build123d 0.13.0", remote: false, href: "file:///part/cad/part.step" });
    expect(by.glb.kindLabel).toBe("3D model");
    expect(by.if_usb).toMatchObject({ kindLabel: "Interface geometry", group: "data" });
    expect(by.sch.kind).toBe("schematic");
    expect(by.top).toMatchObject({ kind: "pcb", kindLabel: "PCB top" });
    expect(by.lid.kindLabel).toBe("Print model");
    expect(by.src.kindLabel).toBe("CAD source");
    expect(by.manifest.kindLabel).toBe("Manifest");
    expect(classifyArtifact(art({ id: "x", filePath: "notes.pdf" })).group).toBe("documents");
    expect(hostOf("https://www.ti.com/lit/ds/x.pdf")).toBe("ti.com");
    expect(hostOf("parts/x.pdf")).toBeUndefined();
  });

  it("shows an image as itself, and a model only by the picture the host gives", () => {
    const by = (o?: Parameters<typeof artifactCards>[2]) => Object.fromEntries(artifactCards(def, files, o).map((c) => [c.artifactId, c.preview]));
    const plain = by();
    expect(plain.thumb).toEqual({ kind: "image", src: "file:///part/img/part.png" });
    expect(plain.sch).toEqual({ kind: "image", src: "file:///part/out/schematic.svg" });
    expect(plain.photo).toEqual({ kind: "image", src: "https://cdn-shop.adafruit.com/970x728/381-02.jpg?v=3" });
    // no model is loaded for a card unless the host says so
    expect(plain.glb).toBeUndefined();
    expect(plain.step).toBeUndefined();
    // a datasheet is a document: its icon, never a fetch
    expect(plain.ds).toBeUndefined();
    const hosted = by({ remoteImages: false, previewFor: (_d, a) => (a.id === "glb" ? { kind: "model", src: "m.glb" } : a.id === "step" ? { kind: "image", src: "exported.png" } : undefined) });
    expect(hosted.photo).toBeUndefined();
    expect(hosted.glb).toEqual({ kind: "model", src: "m.glb" });
    expect(hosted.step).toEqual({ kind: "image", src: "exported.png" });
    // a file the host does not resolve shows no picture
    expect(artifactCards(def, () => undefined).find((c) => c.artifactId === "thumb")!.preview).toBeUndefined();
  });

  it("carries the source of a datasheet from the part's evidence, and lists evidence sources as cards", () => {
    const sources = [
      { id: "s1", title: "DS18B20 datasheet", url: "https://www.analog.com/media/DS18B20.pdf", type: "datasheet", authority: "manufacturer", fetched_at: "2026-10-03T02:40:00Z" },
      { id: "s2", title: "Distributor listing", url: "https://www.digikey.com/x", type: "documentation", authority: "distributor" },
    ];
    const cards = artifactCards(def, files, { sources, evidence: true });
    expect(cards.find((c) => c.artifactId === "ds")).toMatchObject({ source: "analog.com", sourceNote: "manufacturer · fetched 2026-10-03" });
    // the source no artifact names is a card of its own; the datasheet is not repeated
    expect(cards.filter((c) => c.kind === "evidence").map((c) => c.title)).toEqual(["Distributor listing"]);
    expect(evidenceSourceCards("part", sources).map((c) => [c.kindLabel, c.source, c.sourceNote, c.href])).toEqual([
      ["Datasheet", "analog.com", "manufacturer · fetched 2026-10-03", "https://www.analog.com/media/DS18B20.pdf"],
      ["Documentation", "digikey.com", "distributor", "https://www.digikey.com/x"],
    ]);
  });
});

describe("the inspector's details on their own", () => {
  const render = (props: Partial<Parameters<typeof SelectionDetails>[0]> & Pick<Parameters<typeof SelectionDetails>[0], "target">) => renderToStaticMarkup(createElement(SelectionDetails, { bundle, resolveArtifact: files, ...props }));
  const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

  it("shows a module as the viewer's inspector does, every artifact a card and no model loaded", () => {
    const html = render({ target: { kind: "module", path: "enclosure" } });
    expect(html).toContain("sample-imu-enclosure");
    expect(html).toContain("ARTIFACTS · 4");
    expect(count(html, /class="uhd-artifact-card /g)).toBe(4);
    // no plain file rows, no 3D preview, no title or action buttons of the viewer's own panel
    expect(html).not.toContain("artifact-file");
    expect(html).not.toContain("artifact-cad");
    expect(html).not.toContain("details-title");
    expect(html).not.toContain("OPEN SOURCE");
    expect(html).toContain("INTERFACES");
  });

  it("shows a board's drawings and outputs as cards, without fetching a drawing", () => {
    const html = render({ target: { kind: "module", path: "board" } });
    expect(html).toContain("BOARD OUTPUTS");
    expect(count(html, /class="uhd-artifact-card /g)).toBe(8);
    for (const kind of ["schematic", "pcb"]) expect(html).toContain(`data-artifact-kind="${kind}"`);
    expect(html).not.toContain("board-drawing-view");
    // the drawings are pictures, loaded lazily
    expect(count(html, /<img [^>]*loading="lazy"/g)).toBe(3);
  });

  it("draws a model's card with the picture the host gives, and the model itself never", () => {
    const html = render({ target: { kind: "module", path: "enclosure" }, host: { artifactPreview: (_d, a) => (a.id === "enclosure_glb" ? { kind: "image", src: "exported/part.png" } : undefined) } });
    expect(html).toContain('src="exported/part.png"');
    expect(html).not.toMatch(/<img [^>]*\.glb/);
  });

  it("shows a component inside a board, a link of the system, a definition on its own, and the root", () => {
    expect(render({ target: { kind: "module", path: "board/u2" } })).toContain("fixture-imu-lga12");
    const link = render({ target: { kind: "link", owner: "", ids: ["board_mount"] } });
    expect(link).toContain("PROTOCOL");
    expect(link).toContain("pair-preview");
    const alone = render({ target: { kind: "definition", id: "fixture-mcu-qfn32" } });
    expect(alone).toContain("fixture-mcu-qfn32");
    expect(alone).toContain("PINS");
    // a definition outside the bundle (a library part)
    const extra = { id: "lib-part", name: "Library part", kind: "module", interfaces: [], artifacts: [art({ id: "ds", type: "datasheet", url: "https://example.com/ds.pdf" })] } as unknown as ModuleDef;
    const lib = renderToStaticMarkup(createElement(SelectionDetails, { definitions: [extra], target: { kind: "definition", id: "lib-part" } }));
    expect(lib).toContain("example.com");
    expect(lib).toContain('data-artifact-kind="datasheet"');
    expect(render({ target: { kind: "module", path: "" } })).toContain("sample-imu-pod");
  });

  it("shows an instance the diagram does not draw as a node by its definition, at its path", () => {
    // a module below a component that the level does not open: found by walking the path
    const nested = JSON.parse(JSON.stringify(bundle)) as UhdBundle;
    const defs = nested.definitions as unknown as ModuleDef[];
    defs.push({ id: "screw-stack", name: "Screw stack", kind: "harness", interfaces: [], fastenerStack: [] } as unknown as ModuleDef);
    defs.find((d) => d.id === nested.root)!.children!.push({ id: "screws", moduleDefId: "screw-stack", name: "Screws" } as never);
    const html = renderToStaticMarkup(createElement(SelectionDetails, { bundle: nested, target: { kind: "module", path: "screws" } }));
    expect(html).toContain("screw-stack");
    expect(html).toContain(">screws<");
  });

  it("says nothing of its own when the target is not in the bundle", () => {
    expect(render({ target: { kind: "module", path: "nowhere" }, missing: "gone" })).toBe("gone");
    expect(render({ target: { kind: "link", owner: "", ids: ["nope"] }, missing: "gone" })).toBe("gone");
  });
});
