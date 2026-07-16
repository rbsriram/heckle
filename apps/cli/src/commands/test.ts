import {
  ReplayEngine,
  ReproStore,
  changedFiles,
  selectRegressionRepros,
  type ReplayResult,
} from "../../../../packages/replay/src/index.ts";

interface TestArgs {
  changed: boolean;
  files: string[];
  origin?: string;
}

function parseArgs(argv: string[]): TestArgs {
  const args: TestArgs = { changed: false, files: [] };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--changed") args.changed = true;
    else if (value === "--url") args.origin = argv[++index];
    else if (args.changed) args.files.push(value);
    else throw new Error(`unexpected test argument: ${value}`);
  }
  if (argv.includes("--url") && !args.origin) throw new Error("--url requires an origin");
  return args;
}

export async function runRegressionTests(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const store = new ReproStore(process.cwd());
  const artifacts = store.list();
  const files = args.changed ? changedFiles(process.cwd(), args.files) : undefined;
  const selected = selectRegressionRepros(artifacts, files);
  const quarantined = artifacts.filter((artifact) => artifact.determinism.quarantined);
  if (args.changed) console.log(`[heckle] changed files: ${files?.length ? files.join(", ") : "none"}`);
  if (quarantined.length) console.log(`[heckle] quarantined: ${quarantined.map((artifact) => artifact.id).join(", ")}`);
  if (!selected.length) {
    console.log("[heckle] no promoted repros selected");
    return;
  }
  const engine = new ReplayEngine(store);
  const results: ReplayResult[] = [];
  for (const artifact of selected) {
    const result = await engine.run(artifact, { origin: args.origin });
    results.push(result);
    console.log(`[heckle] ${artifact.id}: ${result.passed ? "PASS" : "FAIL"} ${result.durationMs}ms`);
    if (result.error) console.error(`  ${result.error}`);
    for (const assertion of result.assertions.filter((item) => !item.passed)) {
      console.error(`  ${assertion.assertion.type}: ${assertion.error ?? `observed ${assertion.actual ?? "n/a"}`}`);
    }
  }
  const passed = results.filter((result) => result.passed).length;
  console.log(`[heckle] regressions: ${passed}/${results.length} passed`);
  if (passed !== results.length) process.exitCode = 1;
}
