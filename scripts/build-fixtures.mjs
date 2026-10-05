/**
 * Writes the sample bundles and their hand-made standard outputs
 * (fixtures/imu-pod/, see fixtures/README.md) from fixtures/src/. Run after
 * changing the generator or the UHD fixture board; test/fixtures.test.ts
 * fails while the committed files differ from what this writes.
 *
 *   node scripts/build-fixtures.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runnerImport } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const { module } = await runnerImport(join(root, "fixtures/src/imu-pod.ts"), {
  configFile: false,
  resolve: { alias: { "@uhd": join(root, "../uhd/src") } },
});
const out = join(root, "fixtures/imu-pod");
const { files } = module.buildFixtures();
for (const [path, content] of Object.entries(files)) {
  const file = join(out, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
console.log(`wrote ${Object.keys(files).length} files to ${out}`);
