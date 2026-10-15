import { Hono } from "hono";

// P0: health check and a placeholder page. The API and console arrive in P5.
export const app = new Hono();

app.get("/healthz", (c) => c.text("ok"));

app.get("/", (c) =>
  c.html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentShield</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 32px 16px; background: #fafafa; color: #111; }
  main { max-width: 640px; margin: 0 auto; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } }
</style>
</head>
<body>
<main>
  <h1>AgentShield</h1>
  <p>A policy checkpoint for AI coding agents. The console is coming soon.</p>
</main>
</body>
</html>`),
);
