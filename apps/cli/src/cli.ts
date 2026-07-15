import { runConfig } from "./commands/config.ts";
import { runDev } from "./commands/dev.ts";
import { runInit } from "./commands/init.ts";
import { runMetrics } from "./commands/metrics.ts";
import { VERSION } from "../../../packages/shared/src/version.ts";
import { assertSupportedNode } from "./readiness.ts";

const HELP = `heckle, the live QA co-pilot for agentic development

Usage:
  heckle dev [opts] -- <command>  Start the Heckle daemon, then run <command> with capture attached
                                  On first run it teaches your agent about Heckle automatically.
                                  Opts: --agent <a>, --no-init, --no-proxy, --app-url <url>, --ui-port <n>, --skip-model-check
  heckle init [--agent <a>]   Teach your coding agent about Heckle (claude-code|cursor|codex|all)
  heckle config [...]         Configure the drafting model / voice / keys (or use the widget gear)
                                  e.g. heckle config model deepseek · heckle config key deepseek <key>
  heckle metrics              Show local activation + retention metrics
  heckle version              Print version
  heckle help                 Show this help

Example:
  heckle dev -- npm run dev
`;

export async function run(argv: string[]): Promise<void> {
  assertSupportedNode();
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "dev":
      await runDev(rest);
      return;
    case "init":
      runInit(rest);
      return;
    case "config":
      await runConfig(rest);
      return;
    case "metrics":
      runMetrics();
      return;
    case "version":
    case "--version":
    case "-v":
      console.log(`heckle ${VERSION}`);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return;
    default:
      console.error(`heckle: unknown command "${cmd}"\n`);
      process.stdout.write(HELP);
      process.exitCode = 1;
  }
}
