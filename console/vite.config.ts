import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The console builds to static files next to the server bundle; the server serves them.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    outDir: "../dist/console",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8080", "/healthz": "http://localhost:8080" },
  },
});
