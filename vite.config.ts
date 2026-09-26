import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The viewer reads UHD source and library parts directly from the sibling
// checkout until UHD ships a JSON form (PB-778).
const uhdRoot = fileURLToPath(new URL("../uhd", import.meta.url));

export default defineConfig({
  plugins: [react()],
  // CAD artifacts (GLB, manifests) are fetched from the UHD checkout through Vite's /@fs route
  define: { __UHD_FS__: JSON.stringify(`/@fs${uhdRoot}`) },
  resolve: {
    alias: {
      "@uhd": `${uhdRoot}/src`,
      "@uhd-library": `${uhdRoot}/library`,
    },
  },
  server: {
    port: 5178,
    fs: { allow: [".", uhdRoot] },
  },
});
