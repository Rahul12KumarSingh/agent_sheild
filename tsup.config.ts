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
  clean: true,
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node" },
});
