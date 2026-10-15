import { serve } from "@hono/node-server";
import { app } from "./app.js";

// Cloud Run sets PORT (8080). Locally `npm start` uses the same default.
const port = Number(process.env.PORT ?? 8080);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`AgentShield server listening on http://localhost:${info.port}`);
});
