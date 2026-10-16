import { defineConfig } from "tsup";

// One self-contained file per entry point: hooks start fast and need no node_modules at runtime.
export default defineConfig({
  entry: {
    cli: "src/cli/index.ts",
    server: "src/server/index.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  bundle: true,
  noExternal: [/.*/],
  splitting: false,
  // Only our own bundles: dist/console is built by Vite and must survive a server rebuild.
  clean: ["cli.js", "server.js", "mcp.js"],
  sourcemap: false,
  // Some bundled CommonJS dependencies (yaml) call require() for Node built-ins.
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __agentshieldRequire } from "node:module";\nconst require = __agentshieldRequire(import.meta.url);' },
});
