// An injecting reverse proxy: forward every request to the user's dev server and splice the
// Heckle widget <script> into HTML responses on the way back. This lets `heckle dev` attach
// to any framework with zero changes to the project (no plugin, no script tag). WebSocket
// upgrades (Vite/Next HMR) are passed straight through. Zero third-party deps.
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { connect as netConnect } from "node:net";

export interface InjectingProxyOptions {
  listenPort: number;
  targetHost: string;
  targetPort: number;
  snippet: string; // the HTML to inject (e.g. the Heckle <script> tag)
}

/** Inject `snippet` into an HTML document, once, before </body> (or </head>, or at the end). */
export function injectSnippet(html: string, snippet: string): string {
  if (html.includes("/heckle.js")) return html; // already attached (e.g. plugin also present)
  if (html.includes("</body>")) return html.replace("</body>", `${snippet}</body>`);
  if (html.includes("</head>")) return html.replace("</head>", `${snippet}</head>`);
  return html + snippet;
}

export function startInjectingProxy(opts: InjectingProxyOptions): Server {
  const { listenPort, targetHost, targetPort, snippet } = opts;

  const server = createServer((req, res) => {
    const proxyReq = request(
      {
        host: targetHost,
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `${targetHost}:${targetPort}` },
      },
      (upstream) => {
        const contentType = String(upstream.headers["content-type"] ?? "");
        if (contentType.includes("text/html")) {
          // Buffer HTML so we can inject; content-length changes, so drop it.
          const chunks: Buffer[] = [];
          upstream.on("data", (c: Buffer) => chunks.push(c));
          upstream.on("end", () => {
            const body = injectSnippet(Buffer.concat(chunks).toString("utf8"), snippet);
            const headers = { ...upstream.headers };
            delete headers["content-length"];
            delete headers["content-encoding"]; // we send plain text
            res.writeHead(upstream.statusCode ?? 200, headers);
            res.end(body);
          });
        } else {
          res.writeHead(upstream.statusCode ?? 200, upstream.headers);
          upstream.pipe(res);
        }
      },
    );
    proxyReq.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("heckle proxy: dev server not reachable");
    });
    req.pipe(proxyReq);
  });

  // WebSocket / HMR: replay the raw upgrade to the dev server and pipe both ways.
  server.on("upgrade", (req: IncomingMessage, clientSocket, head) => {
    const upstream = netConnect({ host: targetHost, port: targetPort }, () => {
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n`);
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        upstream.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
      }
      upstream.write("\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });

  server.listen(listenPort, "127.0.0.1");
  return server;
}
