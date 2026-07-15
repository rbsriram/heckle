// The task context receipt: a compact, durable proof of exactly WHAT was approved at the ship
// boundary and under WHICH dispatch posture, written to .heckle/receipts/<task-id>.json when the
// user clicks Ship to agent. It is smaller than the raw capture and safe to paste into an agent
// or review log: it carries the one-line task intent plus hashes and counts, never raw console
// text, network payloads, or DOM content. Lets anyone distinguish "the task was approved" from
// "this exact captured context was approved". (From GitHub issue #1.)
import type { ContextBundle, Feedback } from "../../shared/src/index.ts";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatFeedbackMarkdown } from "./format.ts";

export const RECEIPT_SCHEMA = "heckle.task_context_receipt.v1";

export interface TaskContextReceipt {
  schema: typeof RECEIPT_SCHEMA;
  task_id: string;
  capture_id?: string;
  created_at: string;
  app_url_origin: string;
  route_or_path: string;
  // The approved one-line instruction (post-edit). Already public in the inbox and dispatch log.
  intent: string;
  // sha256 of the user's raw words, so the report is provable without being copied here.
  user_report_hash?: string;
  // sha256 of the canonical task markdown that shipped (formatFeedbackMarkdown(feedback, context)
  // with no timestamp/receipt options), AFTER any user edit. Recompute it to detect an inbox item
  // edited after shipping.
  task_hash: string;
  capture_window: {
    started_at: string;
    ended_at: string;
    event_count: number;
    console_count: number;
    console_error_count: number;
    network_count: number;
    network_error_count: number;
    // sha256 over the full serialized ContextBundle: proves WHICH capture was approved without
    // copying its contents anywhere.
    context_hash: string;
    dom_snapshot_id?: string;
  };
  privacy: {
    local_only: boolean;
    // This receipt never embeds raw captured content; hashes and counts only.
    raw_payloads_included: false;
    // What the capture layer never records at all (computed against the bundle, so the claim
    // can never contradict what is actually attached).
    not_captured: string[];
  };
  dispatch: {
    agent: string; // "claude-code" | "cursor" | "codex" | "inbox"
    session_mode?: string;
    permission_mode?: string;
    allowed_tools?: string[];
    sandbox?: string;
    // Always true by construction: the receipt is only written by the approval gate firing.
    approved_by_user: true;
    approved_at: string;
    user_edited: boolean;
  };
  artifacts: { inbox: string; dispatch_log: string };
  stale_if: string[];
}

export interface ReceiptDispatchInfo {
  agent: string;
  sessionMode?: string;
  permissionMode?: string;
  allowedTools?: string[];
  sandbox?: string;
  userEdited: boolean;
}

export interface ReceiptInput {
  feedback: Feedback;
  context: ContextBundle;
  transcript?: string; // the user's raw words (hashed, never stored)
  captureId?: string;
  localOnly: boolean;
  dispatch: ReceiptDispatchInfo;
  now?: number; // test override for created_at/approved_at
}

/** Project-relative receipt path; the convention every reference uses. */
export function receiptRelPath(feedbackId: string): string {
  return `.heckle/receipts/${feedbackId}.json`;
}

export function buildTaskContextReceipt(input: ReceiptInput): TaskContextReceipt {
  const { feedback, context, dispatch } = input;
  const now = new Date(input.now ?? Date.now()).toISOString();

  let origin = context.url;
  let route = "";
  try {
    const u = new URL(context.url);
    origin = u.origin;
    route = u.pathname + u.search;
  } catch {
    // a non-URL url stays as-is in origin
  }

  const consoleEntries = context.console ?? [];
  const networkEntries = context.network ?? [];
  const timestamps = [...consoleEntries, ...networkEntries].map((e) => e.ts);
  const startedAt = timestamps.length ? Math.min(...timestamps) : context.capturedAt;

  // The fetch wrapper records method/url/status/duration only; headers and cookies are never
  // captured, and bodies only if some future capture path fills them, so check the bundle.
  const notCaptured = ["request_headers", "response_headers", "cookies"];
  if (!networkEntries.some((e) => e.requestBody != null || e.responseBody != null)) {
    notCaptured.push("request_bodies", "response_bodies");
  }

  return {
    schema: RECEIPT_SCHEMA,
    task_id: feedback.id,
    capture_id: input.captureId,
    created_at: now,
    app_url_origin: origin,
    route_or_path: route,
    intent: feedback.intent,
    user_report_hash: input.transcript != null ? sha256(input.transcript) : undefined,
    task_hash: sha256(formatFeedbackMarkdown(feedback, context)),
    capture_window: {
      started_at: new Date(startedAt).toISOString(),
      ended_at: new Date(context.capturedAt).toISOString(),
      event_count: context.rrwebEvents?.length ?? 0,
      console_count: consoleEntries.length,
      console_error_count: consoleEntries.filter((e) => e.level === "error").length,
      network_count: networkEntries.length,
      network_error_count: networkEntries.filter((e) => e.ok === false || (e.status ?? 0) >= 400).length,
      context_hash: sha256(JSON.stringify(context)),
      dom_snapshot_id: context.domSnapshotId,
    },
    privacy: {
      local_only: input.localOnly,
      raw_payloads_included: false,
      not_captured: notCaptured,
    },
    dispatch: {
      agent: dispatch.agent,
      session_mode: dispatch.sessionMode,
      permission_mode: dispatch.permissionMode,
      allowed_tools: dispatch.allowedTools,
      sandbox: dispatch.sandbox,
      approved_by_user: true,
      approved_at: now,
      user_edited: dispatch.userEdited,
    },
    artifacts: { inbox: ".heckle/inbox.md", dispatch_log: `.heckle/dispatch-${feedback.id}.log` },
    stale_if: [
      "the app route changed since capture",
      "the dev server restarted after capture",
      "the shipped task or inbox item was edited after approval (task_hash no longer matches)",
    ],
  };
}

/** Write the receipt to .heckle/receipts/<task-id>.json; returns the absolute path. */
export function writeTaskContextReceipt(projectRoot: string, receipt: TaskContextReceipt): string {
  const dir = resolve(projectRoot, ".heckle", "receipts");
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${receipt.task_id}.json`);
  writeFileSync(path, JSON.stringify(receipt, null, 2) + "\n");
  return path;
}

/** Best-effort delete when the user removes a row; a stale receipt must not outlive its item. */
export function removeTaskContextReceipt(projectRoot: string, feedbackId: string): void {
  try {
    rmSync(resolve(projectRoot, receiptRelPath(feedbackId)), { force: true });
  } catch {
    // the row removal still stands
  }
}

function sha256(s: string): string {
  return "sha256:" + createHash("sha256").update(s).digest("hex");
}
