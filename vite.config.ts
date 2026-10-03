/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The viewer's input is a UHD bundle (docs: protoboard-cli/docs/specs/uhd-boundary.md).
// It imports UHD itself for types, checks and geometry maths.
const uhdRoot = fileURLToPath(new URL("../uhd", import.meta.url));
// Development default: the ProtoBoard quadcopter project's bundle (`protoboard build`).
// Any other bundle loads with ?bundle=<url>; absolute artifact bases are served via /@fs.
const protoboardRoot = fileURLToPath(new URL("../protoboard-cli", import.meta.url));
const defaultBundle = process.env.UHD_BUNDLE ?? `${protoboardRoot}/examples/quadcopter-5in/.protoboard/build/uhd-bundle.json`;

// The production app (dist/app) has no default bundle and no /@fs: it loads
// ?bundle=<url> or the bundle `uhd-viewer serve` injects, with relative asset
// URLs so it can be served from any path. The library build is vite.lib.config.ts.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === "build" ? "./" : "/",
  define: { __DEFAULT_BUNDLE__: JSON.stringify(command === "build" ? null : `/@fs${defaultBundle}`) },
  resolve: {
    alias: {
      "@uhd": `${uhdRoot}/src`,
    },
  },
  build: { outDir: "dist/app", emptyOutDir: true, chunkSizeWarningLimit: 2500 },
  server: {
    port: 5178,
    // bundles may reference artifacts anywhere in the sibling checkouts during development
    // (real paths too: in a worktree the sibling checkouts may be symlinks)
    fs: { allow: [".", uhdRoot, protoboardRoot, ...[uhdRoot, protoboardRoot].map((p) => realpathSync(p))] },
  },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
}));
