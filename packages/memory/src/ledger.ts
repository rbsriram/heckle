import type { Authority, ReproArtifact } from "../../shared/src/index.ts";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const AUTHORITY: Record<Authority, number> = {
  verification: 5,
  human: 4,
  deterministic: 3,
  agent: 2,
  heuristic: 1,
};

export class Ledger {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  authorityWins(incoming: Authority, current: Authority): boolean {
    return AUTHORITY[incoming] >= AUTHORITY[current];
  }

  private event(
    entityType: string,
    entityId: string,
    action: string,
    payload: unknown,
    authority: Authority,
    owner = "local",
    source = "local",
  ): void {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO ledger_events
       (entity_type,entity_id,action,payload,observed_at,valid_from,superseded_at,authority,owner,source)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(entityType, entityId, action, JSON.stringify(payload), now, now, null, authority, owner, source);
  }

  recordRepro(artifact: ReproArtifact, artifactPath: string): void {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO repros
       (id,issue_id,artifact_path,route,status,observed_at,valid_from,superseded_at,authority,owner,source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET artifact_path=excluded.artifact_path, route=excluded.route`,
    ).run(
      artifact.id,
      artifact.issue_id,
      artifactPath,
      artifact.route,
      "captured",
      now,
      now,
      null,
      "human",
      "local",
      "local",
    );
    this.event("repro", artifact.id, "recorded", { artifactPath, route: artifact.route }, "human");
  }

  recordFix(input: {
    issueId: string;
    reproId?: string;
    diff?: string;
    outcome: string;
    authority: Authority;
    owner?: string;
    source?: string;
  }): string {
    const now = Date.now();
    const id = `fix_${randomUUID()}`;
    this.db.prepare(
      `INSERT INTO fixes
       (id,issue_id,repro_id,diff,outcome,observed_at,valid_from,superseded_at,authority,owner,source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      input.issueId,
      input.reproId ?? null,
      input.diff ?? null,
      input.outcome,
      now,
      now,
      null,
      input.authority,
      input.owner ?? "local",
      input.source ?? "local",
    );
    this.event("fix", id, "recorded", input, input.authority, input.owner, input.source);
    return id;
  }

  startSession(owner = "local", source = "local"): string {
    const now = Date.now();
    const id = `ses_${randomUUID()}`;
    this.db.prepare(
      `INSERT INTO sessions
       (id,started_at,ended_at,observed_at,valid_from,superseded_at,authority,owner,source)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(id, now, null, now, now, null, "human", owner, source);
    this.event("session", id, "started", { startedAt: now }, "human", owner, source);
    return id;
  }

  endSession(id: string): void {
    const endedAt = Date.now();
    this.db.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ?`).run(endedAt, id);
    this.event("session", id, "ended", { endedAt }, "human");
  }

  recordElement(input: {
    stableKey: string;
    sourceFile?: string;
    sourceLine?: number;
    sourceColumn?: number;
    testid?: string;
    authority?: Authority;
  }): string {
    const existing = this.db.prepare(`SELECT id,testid_history,authority FROM elements WHERE stable_key = ?`).get(input.stableKey) as
      | { id: string; testid_history: string; authority: Authority }
      | undefined;
    const now = Date.now();
    if (existing) {
      const authority = input.authority ?? "human";
      if (!this.authorityWins(authority, existing.authority)) return existing.id;
      const history = JSON.parse(existing.testid_history) as string[];
      if (input.testid && !history.includes(input.testid)) history.push(input.testid);
      this.db.prepare(
        `UPDATE elements SET source_file=?,source_line=?,source_column=?,testid_history=?,observed_at=?,authority=? WHERE id=?`,
      ).run(
        input.sourceFile ?? null,
        input.sourceLine ?? null,
        input.sourceColumn ?? null,
        JSON.stringify(history),
        now,
        authority,
        existing.id,
      );
      this.event("element", existing.id, "observed", { ...input, testidHistory: history }, authority);
      return existing.id;
    }
    const id = `elm_${randomUUID()}`;
    this.db.prepare(
      `INSERT INTO elements
       (id,stable_key,source_file,source_line,source_column,testid_history,observed_at,valid_from,superseded_at,authority,owner,source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      input.stableKey,
      input.sourceFile ?? null,
      input.sourceLine ?? null,
      input.sourceColumn ?? null,
      JSON.stringify(input.testid ? [input.testid] : []),
      now,
      now,
      null,
      input.authority ?? "human",
      "local",
      "local",
    );
    this.event("element", id, "recorded", input, input.authority ?? "human");
    return id;
  }

  recordRoute(path: string): string {
    const existing = this.db.prepare(`SELECT id FROM routes WHERE path = ?`).get(path) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = `rte_${randomUUID()}`;
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO routes (id,path,observed_at,valid_from,superseded_at,authority,owner,source)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(id, path, now, now, null, "human", "local", "local");
    this.event("route", id, "recorded", { path }, "human");
    return id;
  }

  close(): void {
    this.db.close();
  }

  recordSignal(fingerprint: string, route: string): string {
    const existing = this.db.prepare(`SELECT id FROM signals WHERE fingerprint = ?`).get(fingerprint) as { id: string } | undefined;
    if (existing) {
      this.db.prepare(`UPDATE signals SET count=count+1,observed_at=? WHERE id=?`).run(Date.now(), existing.id);
      this.event("signal", existing.id, "observed", { fingerprint, route }, "heuristic");
      return existing.id;
    }
    const id = `sig_${randomUUID()}`;
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO signals
       (id,fingerprint,route,count,dismissed,observed_at,valid_from,superseded_at,authority,owner,source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, fingerprint, route, 1, 0, now, now, null, "heuristic", "local", "local");
    this.event("signal", id, "recorded", { fingerprint, route }, "heuristic");
    return id;
  }
}
