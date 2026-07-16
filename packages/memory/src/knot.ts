// Knot-lite: the issue tracker + semantic recall that produces the hero moment
// ("you flagged this before, it's still open"). The moat.
import type { HistoryAnnotation, Issue, IssueStatus } from "../../shared/src/index.ts";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { cosine, type Embedder } from "./embed.ts";

export interface RelatedIssue {
  issue: Issue;
  score: number;
  flaggedCount: number;
}

interface Row {
  id: string;
  status: string;
  created_at: number;
  updated_at: number;
  flow: string | null;
  summary: string;
  context_ref: string | null;
  flagged_count: number;
  embedding: string;
  observed_at: number;
  valid_from: number;
  superseded_at: number | null;
  authority: string;
  owner: string;
  source: string;
}

function rowToIssue(r: Row): Issue {
  return {
    id: r.id,
    status: r.status as IssueStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    flow: r.flow ?? undefined,
    summary: r.summary,
    contextRef: r.context_ref ?? undefined,
    observedAt: r.observed_at,
    validFrom: r.valid_from,
    supersededAt: r.superseded_at ?? undefined,
    authority: r.authority as Issue["authority"],
    owner: r.owner,
    source: r.source,
  };
}

export class Knot {
  private readonly db: DatabaseSync;
  private readonly embedder: Embedder;

  constructor(db: DatabaseSync, embedder: Embedder) {
    this.db = db;
    this.embedder = embedder;
  }

  private appendVersion(id: string, validFrom: number): void {
    this.db.prepare(
      `INSERT INTO issue_versions
       (issue_id,status,observed_at,valid_from,superseded_at,authority,owner,source,flow,summary,context_ref,flagged_count)
       SELECT id,status,observed_at,?,NULL,authority,owner,source,flow,summary,context_ref,flagged_count
       FROM issues WHERE id = ?`,
    ).run(validFrom, id);
    const row = this.db.prepare(`SELECT status,authority,owner,source,flagged_count FROM issues WHERE id = ?`).get(id) as
      | { status: string; authority: string; owner: string; source: string; flagged_count: number }
      | undefined;
    if (row) {
      this.db.prepare(
        `INSERT INTO ledger_events
         (entity_type,entity_id,action,payload,observed_at,valid_from,superseded_at,authority,owner,source)
         VALUES ('issue',?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        "versioned",
        JSON.stringify({ status: row.status, flaggedCount: row.flagged_count }),
        validFrom,
        validFrom,
        null,
        row.authority,
        row.owner,
        row.source,
      );
    }
  }

  private transition(id: string, mutate: () => void): void {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`UPDATE issue_versions SET superseded_at = ? WHERE issue_id = ? AND superseded_at IS NULL`).run(now, id);
      mutate();
      this.db.prepare(`UPDATE issues SET updated_at = ?, observed_at = ?, valid_from = ?, superseded_at = NULL WHERE id = ?`).run(now, now, now, id);
      this.appendVersion(id, now);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async addIssue(input: { summary: string; flow?: string; contextRef?: string }): Promise<Issue> {
    const emb = await this.embedder.embed(input.summary);
    const now = Date.now();
    const id = `iss_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO issues
         (id,status,created_at,updated_at,flow,summary,context_ref,flagged_count,embedding,observed_at,valid_from,superseded_at,authority,owner,source)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        "open",
        now,
        now,
        input.flow ?? null,
        input.summary,
        input.contextRef ?? null,
        1,
        JSON.stringify(Array.from(emb)),
        now,
        now,
        null,
        "human",
        "local",
        "local",
      );
    this.appendVersion(id, now);
    return {
      id,
      status: "open",
      createdAt: now,
      updatedAt: now,
      flow: input.flow,
      summary: input.summary,
      contextRef: input.contextRef,
      observedAt: now,
      validFrom: now,
      authority: "human",
      owner: "local",
      source: "local",
    };
  }

  /** Semantic search prior issues; return matches at/above the cosine threshold, best first. */
  async recall(text: string, opts: { threshold?: number; limit?: number } = {}): Promise<RelatedIssue[]> {
    // nomic-embed-text: same-bug paraphrases ~0.75, different bug ~0.52, unrelated ~0.3.
    // 0.65 catches a re-flag of the same issue while excluding merely-same-app feedback.
    const threshold = opts.threshold ?? 0.65;
    const limit = opts.limit ?? 3;
    const rows = this.db.prepare(`SELECT * FROM issues`).all() as unknown as Row[];
    if (!rows.length) return [];
    const q = await this.embedder.embed(text);
    return rows
      .map((r) => ({
        issue: rowToIssue(r),
        flaggedCount: r.flagged_count,
        score: cosine(q, Float32Array.from(JSON.parse(r.embedding) as number[])),
      }))
      .filter((s) => s.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Record that an existing issue was flagged again; returns the new flag count. */
  bumpFlag(id: string): number {
    this.transition(id, () => {
      this.db.prepare(
        `UPDATE issues SET flagged_count = flagged_count + 1,
         status = CASE WHEN status = 'fixed' THEN 'recurring' ELSE status END,
         authority = 'human' WHERE id = ?`,
      ).run(id);
    });
    const r = this.db.prepare(`SELECT flagged_count FROM issues WHERE id = ?`).get(id) as { flagged_count: number } | undefined;
    return r?.flagged_count ?? 1;
  }

  markFixed(id: string, authority: Issue["authority"] = "agent"): void {
    this.transition(id, () => {
      this.db.prepare(`UPDATE issues SET status = 'fixed', authority = ? WHERE id = ?`).run(authority, id);
    });
  }

  list(): Issue[] {
    return (this.db.prepare(`SELECT * FROM issues ORDER BY updated_at DESC`).all() as unknown as Row[]).map(rowToIssue);
  }

  close(): void {
    this.db.close();
  }
}

/** Map a matched prior issue (after this re-flag) into the review-card annotation. */
export function historyFor(issue: Issue, flaggedCount: number): HistoryAnnotation {
  if (issue.status === "fixed" || issue.status === "recurring") {
    return { kind: "recurring", note: "You flagged this before, it was fixed and it's back.", issueId: issue.id };
  }
  if (flaggedCount >= 3) {
    return { kind: "recurring", note: `You've flagged this ${flaggedCount}× and it's still open.`, issueId: issue.id };
  }
  return { kind: "still-open", note: "You flagged this before and it's still open.", issueId: issue.id };
}
