import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The viewer's input is a UHD bundle (docs: protoboard-cli/docs/specs/uhd-boundary.md).
// It imports UHD itself for types, checks and geometry maths.
const uhdRoot = fileURLToPath(new URL("../uhd", import.meta.url));
// Development default: the ProtoBoard quadcopter project's bundle (`protoboard build`).
// Any other bundle loads with ?bundle=<url>; absolute artifact bases are served via /@fs.
const protoboardRoot = fileURLToPath(new URL("../protoboard-cli", import.meta.url));
const defaultBundle = process.env.UHD_BUNDLE ?? `${protoboardRoot}/examples/quadcopter-5in/.protoboard/build/uhd-bundle.json`;

export default defineConfig({
  plugins: [react()],
  define: { __DEFAULT_BUNDLE__: JSON.stringify(`/@fs${defaultBundle}`) },
  resolve: {
    alias: {
      "@uhd": `${uhdRoot}/src`,
    },
  },
  server: {
    port: 5178,
    // bundles may reference artifacts anywhere in the sibling checkouts during development
    fs: { allow: [".", uhdRoot, protoboardRoot] },
  },
});
