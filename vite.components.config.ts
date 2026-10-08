import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// The component library (src/components.ts → dist/components): React, Three,
// React Flow, Radix and Lucide stay imports (the host's bundle has one copy of
// each); UHD's maths is bundled in, as in the app. One stylesheet.
const uhdRoot = fileURLToPath(new URL("../uhd", import.meta.url));
const peers = ["react", "react-dom", "three", "@xyflow/react", "@radix-ui/react-scroll-area", "lucide-react"];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@uhd": `${uhdRoot}/src` } },
  build: {
    outDir: "dist/components",
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
    minify: false,
    sourcemap: true,
    lib: { entry: "src/components.ts", formats: ["es"], fileName: () => "index.js", cssFileName: "components" },
    rollupOptions: {
      external: (id) => peers.some((p) => id === p || id.startsWith(`${p}/`)),
    },
  },
});
