import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The live AI judge never runs in tests: no network, deterministic results. Tests that cover it inject a transport.
    env: { AGENTSHIELD_AI: "off" },
  },
});
