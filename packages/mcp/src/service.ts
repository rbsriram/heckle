import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Ledger, openDb } from "../../memory/src/index.ts";
import {
  ReplayEngine,
  ReproStore,
  VerificationEngine,
  selectRegressionRepros,
  type ReplayResult,
} from "../../replay/src/index.ts";

interface IssueRow {
  id: string;
  status: string;
  summary: string;
  severity: string;
  flow: string | null;
  context_ref: string | null;
  updated_at: number;
  authority: string;
  owner: string;
  source: string;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export class HeckleMcpService {
  private readonly projectRoot: string;
  private readonly db: DatabaseSync;
  private readonly ledger: Ledger;
  private readonly store: ReproStore;
  private readonly replay: Pick<ReplayEngine, "run">;
  private readonly verification: Pick<VerificationEngine, "verify">;
  private readonly localOnly: boolean;

  constructor(
    projectRoot: string = process.cwd(),
    options: {
      replay?: Pick<ReplayEngine, "run">;
      verification?: Pick<VerificationEngine, "verify">;
      localOnly?: boolean;
    } = {},
  ) {
    this.projectRoot = projectRoot;
    const dbPath = resolve(projectRoot, ".heckle", "heckle.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = openDb(dbPath);
    this.ledger = new Ledger(this.db);
    this.store = new ReproStore(projectRoot);
    this.replay = options.replay ?? new ReplayEngine(this.store);
    this.verification = options.verification ?? new VerificationEngine(this.store, { ledger: this.ledger });
    this.localOnly = options.localOnly ?? true;
  }

  private checkedOrigin(override: unknown, captured: string): string | undefined {
    const value = typeof override === "string" ? override : captured;
    if (this.localOnly) {
      const host = new URL(value).hostname;
      if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
        throw new Error(`local-only mode refuses replay against non-loopback origin: ${host}`);
      }
    }
    return typeof override === "string" ? override : undefined;
  }

  async callTool(name: string, input: Record<string, unknown> = {}): Promise<unknown> {
    if (name === "heckle_list_open") return this.listOpen(input);
    if (name === "heckle_get_task") return this.getTask(requiredString(input, "issue_id"));
    if (name === "heckle_search_memory") return this.search(requiredString(input, "query"));
    if (name === "heckle_check_regressions") return this.checkRegressions(input);
    if (name === "heckle_run_repro") return this.runRepro(requiredString(input, "repro_id"), input.origin);
    if (name === "heckle_mark_ready") return this.markReady(requiredString(input, "issue_id"), input.origin);
    if (name === "heckle_get_fix_history") return this.fixHistory(input);
    throw new Error(`unknown Heckle tool: ${name}`);
  }

  close(): void {
    this.ledger.close();
  }

  private listOpen(input: Record<string, unknown>): unknown[] {
    const route = typeof input.route === "string" ? input.route : undefined;
    const severity = typeof input.severity === "string" ? input.severity : undefined;
    const rows = this.db.prepare(`SELECT * FROM issues WHERE status != 'fixed' ORDER BY updated_at DESC`).all() as unknown as IssueRow[];
    return rows.filter((issue) => {
      const repro = this.store.list().find((artifact) => artifact.issue_id === issue.id);
      if (route && repro?.route !== route && issue.flow !== route) return false;
      if (severity && issue.severity !== severity) return false;
      return true;
    }).map((issue) => ({
      issue_id: issue.id,
      status: issue.status,
      summary: issue.summary,
      severity: issue.severity,
      flow: issue.flow,
      updated_at: new Date(issue.updated_at).toISOString(),
      authority: issue.authority,
      owner: issue.owner,
      source: issue.source,
    }));
  }

  private getTask(issueId: string): unknown {
    const issue = this.db.prepare(`SELECT * FROM issues WHERE id=?`).get(issueId) as unknown as IssueRow | undefined;
    if (!issue) throw new Error(`issue not found: ${issueId}`);
    const repro = this.store.list().find((artifact) => artifact.issue_id === issueId);
    const receipt = issue.context_ref
      ? readJson(resolve(this.projectRoot, ".heckle", "receipts", `${issue.context_ref}.json`))
      : undefined;
    const captures = readJson(resolve(this.projectRoot, ".heckle", "captures.json"));
    return {
      issue,
      receipt,
      capture: Array.isArray(captures)
        ? captures.find((item) => item && typeof item === "object" && (item.feedbackId === issue.context_ref || item.reproId === repro?.id))
        : undefined,
      repro,
    };
  }

  private search(query: string): unknown {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const issues = (this.db.prepare(`SELECT * FROM issues ORDER BY updated_at DESC`).all() as unknown as IssueRow[])
      .map((issue) => ({ issue, score: words.filter((word) => `${issue.summary} ${issue.flow ?? ""}`.toLowerCase().includes(word)).length }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
    const fixes = this.db.prepare(
      `SELECT id,issue_id,repro_id,outcome,observed_at,authority,owner,source FROM fixes
       WHERE lower(outcome) LIKE ? OR lower(COALESCE(diff,'')) LIKE ? ORDER BY observed_at DESC LIMIT 20`,
    ).all(`%${query.toLowerCase()}%`, `%${query.toLowerCase()}%`);
    return { issues, fixes };
  }

  private async checkRegressions(input: Record<string, unknown>): Promise<unknown> {
    const files = Array.isArray(input.changed_files)
      ? input.changed_files.filter((file): file is string => typeof file === "string")
      : undefined;
    const selected = selectRegressionRepros(this.store.list(), files);
    if (input.run !== true) return { repros: selected.map((artifact) => artifact.id), results: [] };
    const results: ReplayResult[] = [];
    for (const artifact of selected) {
      results.push(await this.replay.run(artifact, { origin: this.checkedOrigin(input.origin, artifact.origin) }));
    }
    return { repros: selected.map((artifact) => artifact.id), results };
  }

  private async runRepro(reproId: string, origin: unknown): Promise<ReplayResult> {
    const artifact = this.store.load(reproId);
    if (!artifact) throw new Error(`repro not found: ${reproId}`);
    return this.replay.run(artifact, { origin: this.checkedOrigin(origin, artifact.origin) });
  }

  private async markReady(issueId: string, origin: unknown): Promise<unknown> {
    const artifact = this.store.list().find((candidate) => candidate.issue_id === issueId);
    if (!artifact) throw new Error(`no repro found for issue: ${issueId}`);
    return this.verification.verify(artifact, { origin: this.checkedOrigin(origin, artifact.origin) });
  }

  private fixHistory(input: Record<string, unknown>): unknown[] {
    const route = typeof input.route === "string" ? input.route : undefined;
    const element = typeof input.element === "string" ? input.element : undefined;
    if (!route && !element) throw new Error("element or route is required");
    const reproIds = this.store.list()
      .filter((artifact) => (!route || artifact.route === route) && (!element || artifact.surfaces?.elements.includes(element)))
      .map((artifact) => artifact.id);
    if (!reproIds.length) return [];
    const placeholders = reproIds.map(() => "?").join(",");
    return this.db.prepare(
      `SELECT id,issue_id,repro_id,outcome,diff,observed_at,authority,owner,source
       FROM fixes WHERE repro_id IN (${placeholders}) ORDER BY observed_at DESC`,
    ).all(...reproIds) as unknown[];
  }
}
