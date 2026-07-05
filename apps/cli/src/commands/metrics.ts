// `heckle metrics`, read the local instrumentation log (activation + retention).
import { formatMetrics, openMetrics } from "@heckle/daemon";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function runMetrics(): void {
  const dbPath = resolve(process.cwd(), ".heckle", "metrics.db");
  if (!existsSync(dbPath)) {
    console.log("No metrics yet, run `heckle dev` and flag something in the widget first.");
    return;
  }
  const m = openMetrics(dbPath);
  console.log(`Heckle metrics  (${dbPath})\n`);
  console.log(formatMetrics(m.summary()));
  m.close();
}
