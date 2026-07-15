import { ReplayEngine, ReproStore } from "../../../../packages/replay/src/index.ts";

interface ReplayArgs {
  id?: string;
  live: boolean;
  headed: boolean;
  runs: number;
  origin?: string;
}

function parseArgs(argv: string[]): ReplayArgs {
  const args: ReplayArgs = { live: false, headed: false, runs: 3 };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--live") args.live = true;
    else if (value === "--headed") args.headed = true;
    else if (value === "--runs") args.runs = Number(argv[++index]);
    else if (value === "--url") args.origin = argv[++index];
    else if (!args.id) args.id = value;
    else throw new Error(`unexpected replay argument: ${value}`);
  }
  if (!args.id) throw new Error("usage: heckle replay <id> [--runs 3] [--live] [--headed] [--url <origin>]");
  if (!Number.isInteger(args.runs) || args.runs < 1 || args.runs > 20) throw new Error("--runs must be an integer from 1 to 20");
  return args;
}

export async function runReplay(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const store = new ReproStore(process.cwd());
  const artifact = store.load(args.id!);
  if (!artifact) throw new Error(`repro not found: ${args.id}`);
  const engine = new ReplayEngine(store);
  const gate = await engine.gate(artifact, {
    live: args.live,
    headed: args.headed,
    origin: args.origin,
    runs: args.runs,
  });
  gate.results.forEach((result, index) => {
    console.log(`[heckle] replay ${index + 1}/${gate.results.length}: ${result.passed ? "PASS" : "FAIL"} ${result.durationMs}ms`);
    if (result.error) console.error(`  ${result.error}`);
    for (const assertion of result.assertions.filter((item) => !item.passed)) {
      console.error(`  ${assertion.assertion.type}: ${assertion.error ?? `expected mismatch (actual ${assertion.actual ?? "n/a"})`}`);
    }
  });
  console.log(`[heckle] determinism: ${gate.stable ? "stable" : "quarantined"}`);
  if (!gate.stable || !gate.results.every((result) => result.passed)) process.exitCode = 1;
}
