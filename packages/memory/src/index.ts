// @heckle/memory, knot-lite: local issue tracking + semantic recall (the hero moment).
import type { HeckleConfig } from "../../shared/src/index.ts";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openDb } from "./db.ts";
import { OllamaEmbedder } from "./embed.ts";
import { Knot } from "./knot.ts";

export type { Embedder } from "./embed.ts";
export { OllamaEmbedder, cosine } from "./embed.ts";
export { Knot, historyFor, type RelatedIssue } from "./knot.ts";
export { openDb } from "./db.ts";

/** Open the local memory at <projectRoot>/.heckle/heckle.db with a local embedder. */
export function createMemory(config: HeckleConfig, projectRoot: string): Knot {
  const dbPath = resolve(projectRoot, ".heckle", "heckle.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  const model = config.memory?.embedModel ?? "nomic-embed-text";
  const baseUrl = config.drafting.baseUrl || "http://localhost:11434/v1";
  return new Knot(db, new OllamaEmbedder({ baseUrl, model }));
}
