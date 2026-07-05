#!/usr/bin/env node
import { run } from "../src/cli.ts";

run(process.argv.slice(2)).catch((err) => {
  console.error("[heckle]", err instanceof Error ? err.message : err);
  process.exit(1);
});
