// A sample checkout app to test Heckle against.
//   - GET /            the checkout page (total updates on quantity change)
//   - POST /api/order  validates the quantity and returns the computed total
//
// Run it under Heckle so the widget auto-attaches:
//   npx heckle-dev dev -- node examples/sample/server.ts
// When wrapped, HECKLE_DAEMON_URL is set and the daemon's /heckle.js is injected.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const INDEX = fileURLToPath(new URL("./index.html", import.meta.url));
const port = Number(process.env.SAMPLE_PORT ?? 5173);
const daemonUrl = process.env.HECKLE_DAEMON_URL ?? "";
const unitPrice = 20;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/api/order" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let qty: unknown;
      try {
        qty = JSON.parse(body || "{}").qty;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_qty" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, qty, unitPrice, total: qty * unitPrice }));
    });
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    let html = readFileSync(INDEX, "utf8");
    const tag = daemonUrl
      ? `<script src="${daemonUrl}/heckle.js"></script>`
      : `<!-- Heckle not attached. Run: npx heckle-dev dev -- node examples/sample/server.ts -->`;
    html = html.replace("</body>", `    ${tag}\n  </body>`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(port, () => {
  const attached = daemonUrl ? `heckle attached → ${daemonUrl}` : "no heckle (wrap with `heckle dev`)";
  console.log(`[sample] buggy checkout on http://localhost:${port}  (${attached})`);
});
