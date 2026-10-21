import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// The headless layout (src/headless.ts → dist/headless, PB-1007): the diagram's
// layout and its quality metrics without React or a DOM, for hosts that check or
// write a project's layout from Node (`protoboard layout`). UHD's code is bundled in.
const uhdRoot = fileURLToPath(new URL("../uhd", import.meta.url));

export default defineConfig({
  resolve: { alias: { "@uhd": `${uhdRoot}/src` } },
  build: {
    outDir: "dist/headless",
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    target: "node22",
    lib: { entry: "src/headless.ts", formats: ["es"], fileName: () => "index.js" },
  },
});
