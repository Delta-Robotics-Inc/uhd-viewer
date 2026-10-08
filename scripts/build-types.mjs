/**
 * Type declarations for the library build (dist/lib/uhd-viewer.d.ts).
 *
 * The public contract (src/api.ts) holds types only, so it is already a valid
 * declaration file; it only needs its UHD import pointed at the published
 * package, `@deltarobotics/uhd`, instead of the development alias. The result
 * is type-checked against UHD's source before the script succeeds.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "dist/lib");

const api = readFileSync(join(root, "src/api.ts"), "utf8");
const values = api.match(/^export\s+(const|let|var|function|class|enum|default)\b.*$/m);
if (values) throw new Error(`src/api.ts must hold types only, found: ${values[0]}`);
writeFileSync(join(out, "api.d.ts"), api.replaceAll('"@uhd/types/bundle.js"', '"@deltarobotics/uhd"'));
writeFileSync(
  join(out, "uhd-viewer.d.ts"),
  `import type { ViewerHandle, ViewerOptions } from "./api.js";
export type { ArtifactResolver, LinkLayout, ViewerEvent, ViewerHandle, ViewerHostMessage, ViewerLayout, ViewerOptions, ViewerSelection, ViewerTheme, ViewerThemeAdapter, ViewerThemeOption, ViewerView } from "./api.js";
/** Mounts the viewer into an element (it fills the element; give it a height). */
export declare function mountViewer(element: HTMLElement, options: ViewerOptions): ViewerHandle;
`,
);

// check the declarations as a consumer would see them
const tmp = mkdtempSync(join(tmpdir(), "uhd-viewer-types-"));
try {
  writeFileSync(
    join(tmp, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        lib: ["ES2022", "DOM"],
        module: "ESNext",
        moduleResolution: "Bundler",
        skipLibCheck: false,
        // bin/serve.d.mts (the "./serve" export) needs Node's types
        typeRoots: [join(root, "node_modules/@types")],
        types: ["node"],
        paths: { "@deltarobotics/uhd": [join(root, "../uhd/src/types/index.ts")] },
      },
      files: [join(out, "uhd-viewer.d.ts"), join(root, "bin/serve.d.mts")],
    }),
  );
  const tsc = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(tmp, "tsconfig.json")], { encoding: "utf8" });
  if (tsc.status !== 0) throw new Error(`declarations do not type-check:\n${tsc.stdout}${tsc.stderr}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log("dist/lib/uhd-viewer.d.ts written; it and bin/serve.d.mts checked");
