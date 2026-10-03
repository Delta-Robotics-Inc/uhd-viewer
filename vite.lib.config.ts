import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Library build for hosts (src/lib.tsx → dist/lib): one ES module with its own
// React, Three and React Flow, plus one stylesheet. Hosts call mountViewer.
const uhdRoot = fileURLToPath(new URL("../uhd", import.meta.url));

export default defineConfig({
  plugins: [react()],
  // library mode leaves process.env alone; React reads NODE_ENV
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  resolve: { alias: { "@uhd": `${uhdRoot}/src` } },
  build: {
    outDir: "dist/lib",
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
    minify: true,
    lib: { entry: "src/lib.tsx", formats: ["es"], fileName: () => "uhd-viewer.js", cssFileName: "uhd-viewer" },
  },
});
