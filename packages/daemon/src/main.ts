// Runnable entry point for the Heckle daemon. Started as its own process by the CLI
// (`heckle dev`), or standalone via `npm run daemon`.
import { loadConfig } from "./config.ts";
import { startDaemon } from "./server.ts";

const config = await loadConfig();
const daemon = await startDaemon({ config });

console.log(
  `[heckle] daemon listening on ${daemon.url} (ws ${daemon.wsUrl}) ` +
    `(drafting=${config.drafting.provider}:${config.drafting.model}, ` +
    `voice=${config.voice.provider}, localOnly=${config.privacy.localOnly})`,
);

// Warm the local model in the background so the first heckle drafts fast.
daemon.orchestrator.warmup();

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  console.log(`[heckle] daemon shutting down (${signal})`);
  await daemon.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
