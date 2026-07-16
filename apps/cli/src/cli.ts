import { runConfig } from "./commands/config.ts";
import { runDev } from "./commands/dev.ts";
import { runInit } from "./commands/init.ts";
import { runImportCapture } from "./commands/import-capture.ts";
import { runExportLedger } from "./commands/export-ledger.ts";
import { runMetrics } from "./commands/metrics.ts";
import { runMcp } from "./commands/mcp.ts";
import { runReplay } from "./commands/replay.ts";
import { runRegressionTests } from "./commands/test.ts";
import { runUndo } from "./commands/undo.ts";
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
  heckle replay <id> [...]    Replay a repro 3 times (opts: --live, --headed, --runs, --url)
  heckle test [--changed ...] Run promoted regressions, optionally filtered by changed files
  heckle mcp                 Start the local Heckle MCP server over stdio
  heckle undo                Undo the latest deterministic instant edit
  heckle import <file>       Import a capture-only export into the local queue
  heckle export [file]       Export the local team ledger as versioned JSON
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
    case "replay":
      await runReplay(rest);
      return;
    case "test":
      await runRegressionTests(rest);
      return;
    case "mcp":
      await runMcp(rest);
      return;
    case "undo":
      runUndo(rest);
      return;
    case "import":
      await runImportCapture(rest);
      return;
    case "export":
      runExportLedger(rest);
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
