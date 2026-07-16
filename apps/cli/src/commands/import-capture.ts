import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { FileInboxAdapter } from "../../../../packages/delivery/src/index.ts";
import { createCaptureLog } from "../../../../packages/daemon/src/captures.ts";
import { createLedger } from "../../../../packages/memory/src/index.ts";
import type { ContextBundle, Feedback } from "../../../../packages/shared/src/index.ts";

interface CaptureOnlyPayload {
  schema: "heckle-capture@1";
  project: string;
  reporter: string;
  source: "capture-only";
  created_at: string;
  route: string;
  origin: string;
  intent: string;
  repro: string[];
  evidence: { console_errors: string[]; failed_requests: string[] };
}

function parse(path: string): CaptureOnlyPayload {
  if (statSync(path).size > 256 * 1024) throw new Error("capture export exceeds 256KB");
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<CaptureOnlyPayload>;
  if (value.schema !== "heckle-capture@1" || value.source !== "capture-only") throw new Error("unsupported capture export");
  if (!value.intent || !value.route || !value.origin || !value.reporter || !value.project) throw new Error("capture export is missing required fields");
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(value.project) || !/^[a-zA-Z0-9._-]{1,80}$/.test(value.reporter)) throw new Error("capture project and reporter ids are invalid");
  if (value.intent.length > 2_000 || !value.route.startsWith("/") || value.route.length > 500) throw new Error("capture intent or route is invalid");
  if (!Array.isArray(value.repro) || !Array.isArray(value.evidence?.console_errors) || !Array.isArray(value.evidence.failed_requests)) throw new Error("capture export evidence is invalid");
  const lists = [value.repro, value.evidence.console_errors, value.evidence.failed_requests];
  if (lists.some((list) => list.length > 20 || list.some((item) => typeof item !== "string" || item.length > 500))) throw new Error("capture export evidence exceeds limits");
  const origin = new URL(value.origin);
  if ((origin.protocol !== "http:" && origin.protocol !== "https:") || origin.username || origin.password) throw new Error("capture export origin must be HTTP or HTTPS without credentials");
  const created = Date.parse(value.created_at ?? "");
  if (!Number.isFinite(created) || Math.abs(Date.now() - created) > 366 * 24 * 60 * 60 * 1000) throw new Error("capture export timestamp is invalid");
  return {
    schema: "heckle-capture@1",
    project: value.project,
    reporter: value.reporter,
    source: "capture-only",
    created_at: new Date(created).toISOString(),
    route: value.route,
    origin: origin.origin,
    intent: value.intent,
    repro: [...value.repro],
    evidence: { console_errors: [...value.evidence.console_errors], failed_requests: [...value.evidence.failed_requests] },
  };
}

export async function runImportCapture(argv: string[], projectRoot: string = process.cwd()): Promise<void> {
  if (argv.length !== 1) throw new Error("usage: heckle import <capture.json>");
  const payload = parse(resolve(projectRoot, argv[0]));
  const feedbackId = `fb_${randomUUID()}`;
  const issueId = `iss_${randomUUID()}`;
  const feedback: Feedback = {
    id: feedbackId,
    intent: payload.intent,
    target: { flow: payload.route },
    severity: "bug",
    repro: payload.repro,
    context: { consoleRefs: [], networkRefs: [] },
    history: null,
    fixHint: payload.evidence.console_errors.concat(payload.evidence.failed_requests).join("\n") || undefined,
  };
  const context: ContextBundle = {
    url: new URL(payload.route, payload.origin).href,
    flow: payload.route,
    console: [],
    network: [],
    capturedAt: Date.parse(payload.created_at) || Date.now(),
  };
  const ledger = createLedger(projectRoot);
  try {
    ledger.recordTeamMember(payload.reporter, "reporter", payload.reporter);
    ledger.recordTeamMember("local", "shipper", "local");
    ledger.recordIssue({
      id: issueId,
      summary: payload.intent,
      severity: "bug",
      flow: payload.route,
      contextRef: feedbackId,
      owner: payload.reporter,
      source: payload.source,
    });
  } finally {
    ledger.close();
  }
  await new FileInboxAdapter(projectRoot).deliver(feedback, context);
  createCaptureLog(projectRoot).add({
    id: `trg_${randomUUID()}`,
    ts: context.capturedAt,
    url: context.url,
    flow: payload.route,
    transcript: payload.intent,
    console: payload.evidence.console_errors.map((text) => ({ level: "error", text })),
    network: payload.evidence.failed_requests.map((url) => ({ method: "unknown", url, ok: false })),
    stats: { console: payload.evidence.console_errors.length, network: payload.evidence.failed_requests.length, rrweb: 0 },
    outcome: "delivered",
    intent: payload.intent,
    severity: "bug",
    feedbackId,
    owner: payload.reporter,
    source: payload.source,
  });
  console.log(`[heckle] imported ${issueId} from ${payload.reporter} into .heckle/inbox.md`);
}
