import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The viewer reads UHD source and library parts directly from the sibling
// checkout until UHD ships a JSON form (PB-778).
const uhdRoot = fileURLToPath(new URL("../uhd", import.meta.url));

export default defineConfig({
  plugins: [react()],
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
