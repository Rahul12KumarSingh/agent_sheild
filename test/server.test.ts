import { describe, expect, it } from "vitest";
import { app } from "../src/server/app.js";

describe("server", () => {
  it("health check says ok", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("serves the placeholder page", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("AgentShield");
  });
});
