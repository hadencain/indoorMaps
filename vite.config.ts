import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The main app build is single-entry (index.html) again — the read-only
// viewer (Phase C) no longer rides this build. It's built as its own
// self-contained chunk by vite.viewer.config.ts (dist-viewer/), then inlined
// into src/generated/viewer-template.html by scripts/build-viewer-template.mjs.
// See docs/superpowers/plans/2026-07-16-pviewer-single-file.md.
export default defineConfig({
  plugins: [react()],
});
