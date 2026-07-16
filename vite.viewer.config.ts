import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dedicated single-chunk build for the read-only viewer (Phase C packaging).
// The MAIN vite.config.ts builds only index.html — this config builds ONLY
// viewer.html, as ONE self-contained JS chunk + ONE CSS file (no vendor
// splitting, no modulepreload), so scripts/build-viewer-template.mjs can
// inline it into src/generated/viewer-template.html with no broken
// cross-chunk URL imports. See docs/superpowers/plans/2026-07-16-pviewer-single-file.md.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist-viewer",
    rollupOptions: {
      input: "viewer.html",
      output: {
        inlineDynamicImports: true,
        entryFileNames: "viewer.js",
        assetFileNames: "viewer[extname]",
        manualChunks: undefined,
      },
    },
  },
});
