import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // The daemon serves this directory; see core/src/daemon/http-api.ts.
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
  server: {
    // `pnpm --filter @maya/web-client dev` for hot reload against a daemon
    // started separately with `maya attach`. MAYA_PORT names its port.
    proxy: {
      "/api": { target: `http://127.0.0.1:${process.env["MAYA_PORT"] ?? 7777}` },
      "/ws": { target: `ws://127.0.0.1:${process.env["MAYA_PORT"] ?? 7777}`, ws: true },
    },
  },
});
