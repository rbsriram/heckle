import type { HeckleConfig } from "../../shared/src/index.ts";
import { VERSION } from "../../shared/src/version.ts";
import type { ModelProvider } from "../../providers/src/index.ts";
import type { Knot } from "../../memory/src/index.ts";
import type { Metrics } from "./metrics.ts";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator, type OrchestratorOptions } from "./orchestrator.ts";
import { createStt, type Stt } from "./stt.ts";
import { attachWebSocketServer, type WsConnection } from "./ws.ts";

export interface DaemonHandle {
  url: string;
  wsUrl: string;
  port: number;
  server: Server;
  orchestrator: Orchestrator;
  stt: Stt;
  close: () => Promise<void>;
}

const WS_PATH = "/ws";

// Widget assets, served on the fly (no build step): the classic loader, the browser
// ES-modules (TypeScript, type-stripped per request), and rrweb's prebuilt UMD bundle.
const CAPTURE_SRC = fileURLToPath(new URL("../../capture/src/", import.meta.url));
const LOADER_FILE = join(CAPTURE_SRC, "loader.js");
const BROWSER_DIR = join(CAPTURE_SRC, "browser");
const RRWEB_UMD = (() => {
  try {
    const require = createRequire(import.meta.url);
    return join(dirname(require.resolve("rrweb")), "rrweb.umd.min.cjs");
  } catch {
    return "";
  }
})();

const JS_HEADERS = {
  "content-type": "text/javascript; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
};

function serveJsFile(res: ServerResponse, file: string): void {
  if (!file || !existsSync(file)) {
    res.writeHead(404, JS_HEADERS);
    res.end(`console.error("[heckle] asset not found");`);
    return;
  }
  res.writeHead(200, JS_HEADERS);
  res.end(readFileSync(file, "utf8"));
}

/** Serve /heckle* widget assets. Returns true if it handled the request. */
function serveWidgetAsset(pathname: string, res: ServerResponse): boolean {
  if (pathname === "/heckle.js") {
    serveJsFile(res, LOADER_FILE);
    return true;
  }
  if (pathname === "/heckle/vendor/rrweb.js") {
    serveJsFile(res, RRWEB_UMD);
    return true;
  }
  if (pathname.startsWith("/heckle/")) {
    const rel = pathname.slice("/heckle/".length);
    // Single filename only, no slashes, no traversal.
    if (!/^[\w-]+\.(ts|js)$/.test(rel)) {
      res.writeHead(404, JS_HEADERS);
      res.end(`console.error("[heckle] bad asset path");`);
      return true;
    }
    let file = join(BROWSER_DIR, rel);
    if (!existsSync(file) && rel.endsWith(".js")) file = join(BROWSER_DIR, `${rel.slice(0, -3)}.ts`);
    if (!file.startsWith(BROWSER_DIR + sep) || !existsSync(file)) {
      res.writeHead(404, JS_HEADERS);
      res.end(`console.error("[heckle] module not found: ${rel}");`);
      return true;
    }
    const src = readFileSync(file, "utf8");
    const js = file.endsWith(".ts") ? stripTypeScriptTypes(src, { mode: "strip" }) : src;
    res.writeHead(200, JS_HEADERS);
    res.end(js);
    return true;
  }
  return false;
}

/**
 * Start the Heckle daemon, bound to loopback only.
 *   GET  /health           readiness probe
 *   GET  /config           non-secret view of the active config
 *   GET  /heckle.js        injected loader (classic script)
 *   GET  /heckle/*.ts      browser ES-modules, TypeScript stripped on the fly
 *   GET  /heckle/vendor/rrweb.js   rrweb prebuilt UMD
 *   WS   /ws               widget <-> daemon transport
 */
export async function startDaemon(opts: {
  port?: number;
  config: HeckleConfig;
  projectRoot?: string;
  provider?: ModelProvider | null;
  memory?: Knot | null;
  metrics?: Metrics | null;
}): Promise<DaemonHandle> {
  const { config } = opts;
  const port = opts.port ?? Number(process.env.HECKLE_PORT ?? 4317);
  const orchOpts: OrchestratorOptions = {};
  if ("provider" in opts) orchOpts.provider = opts.provider;
  if ("memory" in opts) orchOpts.memory = opts.memory;
  if ("metrics" in opts) orchOpts.metrics = opts.metrics;
  const orchestrator = new Orchestrator(config, opts.projectRoot ?? process.cwd(), orchOpts);
  // Warm the local Parakeet worker only when local voice is actually in use.
  const stt = createStt({ enabled: config.voice.provider === "local" });

  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

    if (serveWidgetAsset(pathname, res)) return;

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }

    // Local speech-to-text: the widget POSTs a WAV, we transcribe on-device and return text.
    if (pathname === "/transcribe" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        try {
          const text = await stt.transcribe(Buffer.concat(chunks));
          res.writeHead(200, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "cache-control": "no-store",
          });
          res.end(JSON.stringify({ text }));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json", "access-control-allow-origin": "*" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
      });
      return;
    }

    const send = (code: number, body: unknown) => {
      // The widget runs on the app's origin (e.g. :5173) and fetches the daemon
      // cross-origin, so /config and /health need CORS or the fetch is blocked.
      res.writeHead(code, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      });
      res.end(JSON.stringify(body));
    };
    switch (pathname) {
      case "/health":
        return send(200, { ok: true, name: "heckle-daemon", version: VERSION });
      case "/config":
        // Never leak secrets, config holds none (keys live in process env only).
        return send(200, {
          drafting: { provider: config.drafting.provider, model: config.drafting.model },
          voice: config.voice,
          agent: config.agent,
          privacy: config.privacy,
          sttAvailable: stt.available,
          wsUrl: `ws://127.0.0.1:${port}${WS_PATH}`,
        });
      default:
        return send(404, { ok: false, error: "not found" });
    }
  });

  // Track live widget connections so the orchestrator can push async updates (e.g. fix status)
  // that are not a direct reply to a request.
  const conns = new Set<WsConnection>();
  orchestrator.setEmitter((m) => {
    const s = JSON.stringify(m);
    for (const c of conns) c.send(s);
  });
  attachWebSocketServer(server, WS_PATH, {
    onConnection: (conn) => {
      conns.add(conn);
      console.log("[heckle] widget connected");
    },
    onMessage: (conn, message) => orchestrator.handleMessage(message, (m) => conn.send(JSON.stringify(m))),
    onClose: (conn) => {
      conns.delete(conn);
      console.log("[heckle] widget disconnected");
    },
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });

  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    wsUrl: `ws://127.0.0.1:${port}${WS_PATH}`,
    port,
    server,
    orchestrator,
    stt,
    close: () =>
      new Promise<void>((resolveClose) => {
        stt.close();
        server.close(() => resolveClose());
      }),
  };
}
