import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // Second entry: the self-contained read-only viewer (Phase C). Its own
      // src/viewer/ tree never imports the store or the authoring app — see
      // docs/superpowers/plans/2026-07-16-pviewer-single-file.md.
      input: {
        main: "index.html",
        viewer: "viewer.html",
      },
    },
  },
});
