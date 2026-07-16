import { execFileSync } from "node:child_process";
import type { ReproArtifact } from "../../shared/src/index.ts";
import type { Ledger } from "../../memory/src/index.ts";
import { ReplayEngine, type ReplayResult } from "./engine.ts";
import { ReproStore } from "./store.ts";

export interface VerificationResult {
  reproId: string;
  issueId: string;
  status: "fixed" | "didnt_land" | "quarantined";
  promoted: boolean;
  results: ReplayResult[];
  delta: string[];
}

interface ReplayRunner {
  run(artifact: ReproArtifact, options?: { origin?: string }): Promise<ReplayResult>;
}

function failureDelta(results: ReplayResult[]): string[] {
  const delta = new Set<string>();
  for (const result of results) {
    if (result.error) delta.add(result.error);
    for (const item of result.assertions) {
      if (item.passed) continue;
      if (item.assertion.type === "text_equals") {
        delta.add(`text_equals expected ${JSON.stringify(item.assertion.expected)}, observed ${JSON.stringify(item.actual ?? "")}`);
      } else {
        delta.add(`${item.assertion.type}: ${item.error ?? "failed"}`);
      }
    }
  }
  return [...delta];
}

export class VerificationEngine {
  private readonly store: ReproStore;
  private readonly runner: ReplayRunner;
  private readonly ledger?: Ledger;

  constructor(store: ReproStore, options: { runner?: ReplayRunner; ledger?: Ledger } = {}) {
    this.store = store;
    this.runner = options.runner ?? new ReplayEngine(store);
    this.ledger = options.ledger;
  }

  async verify(artifact: ReproArtifact, options: { origin?: string } = {}): Promise<VerificationResult> {
    if (artifact.determinism.runs > 0 && artifact.determinism.quarantined) {
      const result: VerificationResult = {
        reproId: artifact.id,
        issueId: artifact.issue_id,
        status: "quarantined",
        promoted: false,
        results: [],
        delta: ["repro is quarantined because its capture gate was not deterministic"],
      };
      artifact.verification = {
        status: "quarantined",
        runs: 0,
        outcomes: [],
        last_run_at: new Date().toISOString(),
        delta: result.delta,
      };
      this.store.save(artifact);
      return result;
    }
    const results = [await this.runner.run(artifact, options), await this.runner.run(artifact, options)];
    const fixed = results.every((result) => result.passed);
    const now = new Date().toISOString();
    const delta = fixed ? [] : failureDelta(results);
    artifact.verification = {
      status: fixed ? "fixed" : "didnt_land",
      runs: results.length,
      outcomes: results.map((result) => result.passed),
      last_run_at: now,
      promoted_at: fixed ? artifact.verification?.promoted_at ?? now : undefined,
      delta: delta.length ? delta : undefined,
    };
    this.store.save(artifact);
    this.ledger?.recordVerification(artifact, fixed, delta);
    return {
      reproId: artifact.id,
      issueId: artifact.issue_id,
      status: fixed ? "fixed" : "didnt_land",
      promoted: fixed,
      results,
      delta,
    };
  }
}

export function changedFiles(projectRoot: string, explicit: string[] = []): string[] {
  if (explicit.length) return [...new Set(explicit.map((file) => file.replaceAll("\\", "/")))];
  try {
    const output = execFileSync("git", ["-C", projectRoot, "diff", "--name-only", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.split("\n").map((file) => file.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function selectRegressionRepros(artifacts: ReproArtifact[], files?: string[]): ReproArtifact[] {
  const promoted = artifacts.filter(
    (artifact) => artifact.verification?.status === "fixed" && Boolean(artifact.verification.promoted_at) && !artifact.determinism.quarantined,
  );
  if (!files) return promoted;
  const normalized = new Set(files.map((file) => file.replaceAll("\\", "/").replace(/^\.\//, "")));
  return promoted.filter((artifact) => {
    const mapped = artifact.surfaces?.files ?? [];
    if (!mapped.length) return true;
    return mapped.some((file) => normalized.has(file.replaceAll("\\", "/").replace(/^\.\//, "")));
  });
}
