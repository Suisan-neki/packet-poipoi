import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** GitHub Pages: https://<user>.github.io/packet-poipoi/ */
const base = process.env.GITHUB_PAGES === "true" ? "/packet-poipoi/" : "/";
const buildId = process.env.GITHUB_SHA?.slice(0, 7) ?? "local";

export default defineConfig({
  base,
  plugins: [react()],
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  preview: {
    port: 4173,
    strictPort: true,
    host: "127.0.0.1",
    open: true,
  },
});
