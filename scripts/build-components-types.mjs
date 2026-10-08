/**
 * Type declarations for the component library (dist/components/index.d.ts):
 * the sources' declarations, emitted by tsc, with UHD's development alias
 * (`@uhd/...`) pointed at the published package (`@deltarobotics/uhd`, whose
 * root exports every UHD type). The result is type-checked as a consumer sees
 * it before the script succeeds.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "dist/components");
const types = join(out, "types");
const tsc = (project) => spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", project], { encoding: "utf8" });

const tmp = mkdtempSync(join(tmpdir(), "uhd-viewer-components-"));
try {
  rmSync(types, { recursive: true, force: true });
  const emit = tsc(join(root, "tsconfig.components.json"));
  if (emit.status !== 0) throw new Error(`declarations not emitted:\n${emit.stdout}${emit.stderr}`);

  // the emitted tree mirrors the parent folder: keep this package's src, drop UHD's
  const own = join(types, basename(root), "src");
  for (const d of readdirSync(types)) if (d !== basename(root)) rmSync(join(types, d), { recursive: true, force: true });
  const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
  for (const f of walk(types).filter((f) => f.endsWith(".d.ts"))) {
    const text = readFileSync(f, "utf8").replace(/(["'])@uhd\/[^"']+\1/g, '"@deltarobotics/uhd"').replace(/^import ["'][^"']+\.css["'];\n/gm, "");
    writeFileSync(f, text);
  }
  writeFileSync(join(out, "index.d.ts"), `export * from "./${relative(out, join(own, "components.js"))}";\n`);

  // check them as a consumer would
  writeFileSync(
    join(tmp, "consumer.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "react-jsx",
        skipLibCheck: false,
        typeRoots: [join(root, "node_modules/@types")],
        // UHD's source (standing in for the published package) needs Node's types
        types: ["node"],
        paths: { "@deltarobotics/uhd": [join(root, "../uhd/src/index.ts")] },
      },
      files: [join(out, "index.d.ts")],
    }),
  );
  const check = tsc(join(tmp, "consumer.json"));
  if (check.status !== 0) throw new Error(`component declarations do not type-check:\n${check.stdout}${check.stderr}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log("dist/components/index.d.ts written and checked");
