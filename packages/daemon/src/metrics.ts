// Instrumentation: a local event log in node:sqlite (separate db from memory, so no write
// contention). The whole funding story rests on retention, so measure it from day one.
// Activation = the first fix_landed (a spoken/typed heckle that resulted in a landed fix).
// Local by default; nothing leaves the machine.
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type EventName = "session_start" | "heckle_triggered" | "draft_created" | "draft_approved" | "fix_landed";

export interface MetricsSummary {
  counts: Record<string, number>;
  activation: { activated: boolean; at?: number; msFromStart?: number };
  activeDays: string[];
  retentionWeeks: Array<{ week: number; activeDays: number }>;
}

export class Metrics {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        day TEXT NOT NULL,
        event TEXT NOT NULL,
        props TEXT
      );
    `);
  }

  record(event: EventName, props?: Record<string, unknown>): void {
    const ts = Date.now();
    const day = new Date(ts).toISOString().slice(0, 10);
    this.db.prepare(`INSERT INTO events (ts, day, event, props) VALUES (?, ?, ?, ?)`).run(ts, day, event, props ? JSON.stringify(props) : null);
  }

  counts(): Record<string, number> {
    const rows = this.db.prepare(`SELECT event, COUNT(*) AS n FROM events GROUP BY event`).all() as unknown as Array<{ event: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.event, r.n]));
  }

  activation(): { activated: boolean; at?: number; msFromStart?: number } {
    const fix = this.db.prepare(`SELECT MIN(ts) AS ts FROM events WHERE event = 'fix_landed'`).get() as { ts: number | null };
    const start = this.db.prepare(`SELECT MIN(ts) AS ts FROM events WHERE event = 'session_start'`).get() as { ts: number | null };
    if (!fix?.ts) return { activated: false };
    return { activated: true, at: fix.ts, msFromStart: start?.ts ? fix.ts - start.ts : undefined };
  }

  activeDays(): string[] {
    return (this.db.prepare(`SELECT DISTINCT day FROM events ORDER BY day`).all() as unknown as Array<{ day: string }>).map((r) => r.day);
  }

  /** Day-bucketed activity in weeks from the first active day, the retention-cohort basis. */
  retentionWeeks(): Array<{ week: number; activeDays: number }> {
    const days = this.activeDays();
    if (!days.length) return [];
    const first = Date.parse(`${days[0]}T00:00:00Z`);
    const buckets = new Map<number, Set<string>>();
    for (const d of days) {
      const week = Math.floor((Date.parse(`${d}T00:00:00Z`) - first) / (7 * 86_400_000));
      (buckets.get(week) ?? buckets.set(week, new Set()).get(week)!).add(d);
    }
    return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([week, set]) => ({ week: week + 1, activeDays: set.size }));
  }

  summary(): MetricsSummary {
    return { counts: this.counts(), activation: this.activation(), activeDays: this.activeDays(), retentionWeeks: this.retentionWeeks() };
  }

  close(): void {
    this.db.close();
  }
}

export function createMetrics(projectRoot: string): Metrics {
  const path = resolve(projectRoot, ".heckle", "metrics.db");
  mkdirSync(dirname(path), { recursive: true });
  return new Metrics(new DatabaseSync(path));
}

export function openMetrics(dbPath: string): Metrics {
  return new Metrics(new DatabaseSync(dbPath));
}

export function formatMetrics(s: MetricsSummary): string {
  const order: EventName[] = ["session_start", "heckle_triggered", "draft_created", "draft_approved", "fix_landed"];
  const counts = order.map((e) => `${e} ${s.counts[e] ?? 0}`).join(" · ");
  const act = s.activation.activated
    ? `activated${s.activation.msFromStart != null ? ` (first fix ${Math.round(s.activation.msFromStart / 1000)}s after session start)` : ""}`
    : "not yet (no fix_landed)";
  const retention = s.retentionWeeks.map((w) => `wk${w.week}:${w.activeDays}d`).join(" ") || "-";
  return [
    `events:     ${counts}`,
    `activation: ${act}`,
    `active days: ${s.activeDays.length}${s.activeDays.length ? ` (${s.activeDays.join(", ")})` : ""}`,
    `retention:  ${retention}`,
  ].join("\n");
}
