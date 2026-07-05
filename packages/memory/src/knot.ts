// Knot-lite: the issue tracker + semantic recall that produces the hero moment
// ("you flagged this before, it's still open"). The moat.
import type { HistoryAnnotation, Issue, IssueStatus } from "@heckle/shared";
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
  };
}

export class Knot {
  private readonly db: DatabaseSync;
  private readonly embedder: Embedder;

  constructor(db: DatabaseSync, embedder: Embedder) {
    this.db = db;
    this.embedder = embedder;
  }

  async addIssue(input: { summary: string; flow?: string; contextRef?: string }): Promise<Issue> {
    const emb = await this.embedder.embed(input.summary);
    const now = Date.now();
    const id = `iss_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO issues (id,status,created_at,updated_at,flow,summary,context_ref,flagged_count,embedding)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, "open", now, now, input.flow ?? null, input.summary, input.contextRef ?? null, 1, JSON.stringify(Array.from(emb)));
    return { id, status: "open", createdAt: now, updatedAt: now, flow: input.flow, summary: input.summary, contextRef: input.contextRef };
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
    this.db
      .prepare(
        `UPDATE issues SET flagged_count = flagged_count + 1, updated_at = ?,
           status = CASE WHEN status = 'fixed' THEN 'recurring' ELSE status END
         WHERE id = ?`,
      )
      .run(Date.now(), id);
    const r = this.db.prepare(`SELECT flagged_count FROM issues WHERE id = ?`).get(id) as { flagged_count: number } | undefined;
    return r?.flagged_count ?? 1;
  }

  markFixed(id: string): void {
    this.db.prepare(`UPDATE issues SET status = 'fixed', updated_at = ? WHERE id = ?`).run(Date.now(), id);
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
