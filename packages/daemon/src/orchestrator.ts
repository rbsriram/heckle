// The brain. Receives widget messages, holds captured context, drafts feedback via the
// configured provider, and (from M3) runs the approval queue + delivery. M2 scope: on a
// trigger, ack capture, then draft a structured Feedback and send it for review.
import type { CaptureRecord, ClientMessage, ContextBundle, DeliverySelection, Feedback, HeckleConfig, ServerMessage } from "../../shared/src/index.ts";
import { VERSION } from "../../shared/src/version.ts";
import { createProvider, DRAFTING_PRESETS, type ModelProvider, providerKeyEnv } from "../../providers/src/index.ts";
import { FeedbackSchema, isNoIssue } from "../../shared/src/feedback.ts";
import {
  appendVerificationFailure,
  buildTaskContextReceipt,
  createDeliveryChain,
  type DeliveryChain,
  type DeliveryDeps,
  isDispatchAdapter,
  type ReceiptDispatchInfo,
  removeInboxItem,
  removeTaskContextReceipt,
  writeTaskContextReceipt,
} from "../../delivery/src/index.ts";
import { createLedger, createMemory, historyFor, type Knot, type Ledger, type RelatedIssue } from "../../memory/src/index.ts";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type CaptureLog, createCaptureLog } from "./captures.ts";
import { loadConfig, loadUserConfig, saveUserConfig } from "./config.ts";
import { selectionFromConfig, selectionToConfig } from "./delivery-selection.ts";
import { createMetrics, type Metrics } from "./metrics.ts";
import { createReproArtifact, ReplayEngine, ReproStore, VerificationEngine } from "../../replay/src/index.ts";

export interface StoredTrigger {
  id: string;
  intentText: string;
  context: ContextBundle;
  receivedAt: number;
  insist?: boolean; // user overrode a prior "nothing to flag"
}

export interface PendingFeedback {
  feedback: Feedback;
  context: ContextBundle;
  issueId?: string; // the memory issue this draft created or matched
  captureId?: string; // the capture-history record this draft came from
  transcript?: string; // the user's raw words, hashed into the task context receipt
}

type Reply = (msg: ServerMessage) => void;

export interface OrchestratorOptions {
  // Explicit provider override (use `null` to disable drafting, e.g. in capture-only tests).
  provider?: ModelProvider | null;
  // Delivery wiring overrides (injected spawn/which for tests).
  delivery?: DeliveryDeps;
  // Explicit memory override (use `null` to disable recall, or inject a fake-embedder Knot).
  memory?: Knot | null;
  // Explicit metrics override (use `null` to disable the event log in tests).
  metrics?: Metrics | null;
  ledger?: Ledger | null;
  verification?: Pick<VerificationEngine, "verify"> | null;
}

export class Orchestrator {
  private triggers: StoredTrigger[] = [];
  private readonly pending = new Map<string, PendingFeedback>();
  private readonly delivered = new Map<string, PendingFeedback>();
  private readonly verificationAttempts = new Map<string, number>();
  private readonly verificationInFlight = new Set<string>();
  // feedbackId -> issueId, kept past approval so a completed fix can mark the issue fixed.
  private readonly issueByFeedback = new Map<string, string>();
  // Rebuilt when the gear changes the drafting model, so these are not readonly.
  private config: HeckleConfig;
  private readonly projectRoot: string;
  private readonly heckleDir: string;
  private provider: ModelProvider | null;
  // Rebuilt when the widget changes the delivery selection, so it is not readonly.
  private delivery: DeliveryChain;
  private readonly deliveryDeps: DeliveryDeps;
  private selection: DeliverySelection;
  private readonly memory: Knot | null;
  private readonly metrics: Metrics | null;
  private readonly ledger: Ledger | null;
  private readonly ledgerSessionId?: string;
  private readonly verification: Pick<VerificationEngine, "verify"> | null;
  private readonly captureGate: Pick<ReplayEngine, "gate"> | null;
  private readonly reproStore: ReproStore;
  private readonly captures: CaptureLog;
  // feedbackId -> captureId, kept past delivery so a completed fix can update its history record.
  private readonly captureByFeedback = new Map<string, string>();
  // Async push channel to the widget (set by the server); no-op until wired.
  private emit: (msg: ServerMessage) => void = () => {};
  private providerError?: string;

  constructor(config: HeckleConfig, projectRoot: string = process.cwd(), opts: OrchestratorOptions = {}) {
    this.config = config;
    this.projectRoot = projectRoot;
    this.heckleDir = resolve(projectRoot, ".heckle");
    this.captures = createCaptureLog(projectRoot);
    this.reproStore = new ReproStore(projectRoot);
    if ("ledger" in opts) {
      this.ledger = opts.ledger ?? null;
    } else {
      try {
        this.ledger = createLedger(projectRoot);
      } catch {
        this.ledger = null;
      }
    }
    this.ledgerSessionId = this.ledger?.startSession();
    this.verification = "verification" in opts
      ? opts.verification ?? null
      : new VerificationEngine(this.reproStore, { ledger: this.ledger ?? undefined });
    this.captureGate = "verification" in opts ? null : new ReplayEngine(this.reproStore);

    if ("metrics" in opts) {
      this.metrics = opts.metrics ?? null;
    } else {
      try {
        this.metrics = createMetrics(projectRoot);
      } catch {
        this.metrics = null;
      }
    }
    this.metrics?.record("session_start");

    this.deliveryDeps = {
      projectRoot,
      ...(opts.delivery ?? {}),
      onDispatchProgress: (feedbackId, line) => {
        // One live line while the fix runs. Update the task's row (clear it when it ends).
        const captureId = this.captureByFeedback.get(feedbackId);
        if (captureId) this.pushCapture(this.captures.setProgress(captureId, line));
      },
      onDispatchComplete: (ok, feedbackId) => {
        void this.finishDispatch(ok, feedbackId);
      },
    };
    this.selection = selectionFromConfig(config);
    this.delivery = createDeliveryChain(config, this.deliveryDeps);
    if ("memory" in opts) {
      this.memory = opts.memory ?? null;
    } else {
      try {
        this.memory = createMemory(config, projectRoot);
      } catch {
        this.memory = null;
      }
    }
    if ("provider" in opts) {
      this.provider = opts.provider ?? null;
    } else {
      try {
        this.provider = createProvider(config);
      } catch (err) {
        this.provider = null;
        this.providerError = (err as Error).message;
      }
    }
  }

  /** Most-recent-first view of captured triggers (used by tests + future memory). */
  get all(): readonly StoredTrigger[] {
    return this.triggers;
  }

  /** Pending drafts awaiting approval (read by tests; delivered in M3). */
  getPending(id: string): PendingFeedback | undefined {
    return this.pending.get(id);
  }

  private async finishDispatch(landed: boolean, feedbackId: string): Promise<void> {
    if (this.verificationInFlight.has(feedbackId)) return;
    this.verificationInFlight.add(feedbackId);
    try {
      await this.finishDispatchUnlocked(landed, feedbackId);
    } finally {
      this.verificationInFlight.delete(feedbackId);
    }
  }

  private async finishDispatchUnlocked(landed: boolean, feedbackId: string): Promise<void> {
    const captureId = this.captureByFeedback.get(feedbackId);
    const capture = captureId ? this.captures.list().find((item) => item.id === captureId) : undefined;
    const issueId = this.issueByFeedback.get(feedbackId);
    if (issueId) {
      this.ledger?.recordFix({
        issueId,
        reproId: capture?.reproId,
        outcome: landed ? "landed" : "failed",
        authority: "agent",
      });
    }
    let fixed = landed;
    let delta: string[] = [];
    if (landed && this.verification) {
      const artifact = capture?.reproId ? this.reproStore.load(capture.reproId) : undefined;
      if (!artifact) {
        fixed = false;
        delta = ["verification could not run because the delivered task has no repro artifact"];
      } else {
        try {
          const verification = await this.verification.verify(artifact);
          fixed = verification.status === "fixed";
          delta = verification.delta;
        } catch (err) {
          fixed = false;
          delta = [`verification could not run: ${(err as Error).message}`];
        }
      }
    }
    if (!fixed && landed && delta.length && (this.verificationAttempts.get(feedbackId) ?? 0) < 1) {
      this.verificationAttempts.set(feedbackId, 1);
      appendVerificationFailure(this.projectRoot, feedbackId, delta);
      if (captureId) this.pushCapture(this.captures.setOutcome(captureId, "failed", { progress: delta[0] }));
      const task = this.delivered.get(feedbackId);
      if (task) {
        console.log(`[heckle] verification failed for ${feedbackId}; dispatching one evidence-backed retry`);
        await this.delivery.deliver(task.feedback, task.context);
        return;
      }
    }
    if (captureId) this.pushCapture(this.captures.setOutcome(captureId, fixed ? "fixed" : "failed", { progress: undefined }));
    this.captureByFeedback.delete(feedbackId);
    this.verificationAttempts.delete(feedbackId);
    this.delivered.delete(feedbackId);
    this.emit({ type: "fixStatus", feedbackId, ok: fixed });
    console.log(`[heckle] fix ${fixed ? "verified" : "DID NOT LAND"} for ${feedbackId}`);
    if (!fixed) return;
    this.metrics?.record("fix_landed", { feedbackId });
    if (issueId) {
      this.memory?.markFixed(issueId, this.verification ? "verification" : "agent");
      this.issueByFeedback.delete(feedbackId);
      console.log(`[heckle] issue ${issueId} marked fixed`);
    }
  }

  close(): void {
    if (this.ledgerSessionId) this.ledger?.endSession(this.ledgerSessionId);
    this.ledger?.close();
  }

  /** Fire-and-forget: warm the local model so the first heckle drafts fast. */
  warmup(): void {
    void this.provider?.warmup?.().catch(() => {});
  }

  handleMessage(raw: string, reply: Reply): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      reply({ type: "error", message: "invalid JSON" });
      return;
    }

    switch (msg.type) {
      case "hello":
        // Tell the gear the current delivery routing, which project this daemon serves (so the
        // widget scopes its saved gear preference), and the current drafting model.
        reply({
          type: "ready",
          daemon: `heckle-daemon@${VERSION}`,
          delivery: this.selection,
          project: this.projectRoot,
          drafting: { provider: this.config.drafting.provider, model: this.config.drafting.model, baseUrl: this.config.drafting.baseUrl },
        });
        return;

      case "trigger":
        this.handleTrigger(msg.intentText, msg.context, reply, msg.insist);
        return;

      case "approve":
        void this.handleApprove(msg.feedbackId, msg.edited, reply);
        return;

      case "run":
        void this.handleRun(msg.captureId, reply);
        return;

      case "remove":
        this.handleRemove(msg.captureId, reply);
        return;

      case "setDelivery":
        this.setDelivery(msg.selection);
        return;

      case "setConfig":
        void this.handleSetConfig(msg, reply);
        return;

      case "history":
        reply({ type: "history", captures: this.captures.list() });
        return;

      default:
        reply({ type: "error", message: `unknown message type` });
    }
  }

  /** The gear changed dispatch routing: rebuild the chain over the boot config, no restart. */
  setDelivery(selection: DeliverySelection): void {
    this.selection = selection;
    this.delivery = createDeliveryChain(selectionToConfig(this.config, selection), this.deliveryDeps);
    console.log(
      `[heckle] delivery set: agent=${selection.agent} session=${selection.session} autonomy=${selection.autonomy}`,
    );
  }

  // The gear changed the drafting model: persist it to the user config layer, then rebuild the
  // effective config + provider live (no restart). Cloud providers turn local-only off.
  private async handleSetConfig(
    msg: { provider?: string; model?: string; baseUrl?: string; apiKey?: string; voice?: string },
    reply: Reply,
  ): Promise<void> {
    const u = loadUserConfig();
    const c = u.config as Record<string, Record<string, unknown>>;
    if (msg.provider) {
      const preset = DRAFTING_PRESETS[msg.provider];
      const provider = preset?.provider ?? msg.provider;
      const baseUrl = msg.baseUrl || preset?.baseUrl;
      c.drafting = { ...(c.drafting ?? {}), provider };
      if (msg.model) c.drafting.model = msg.model;
      if (baseUrl) c.drafting.baseUrl = baseUrl;
      c.privacy = { ...(c.privacy ?? {}), localOnly: provider === "ollama" };
      // Store the key under the provider's env var (anthropic uses ANTHROPIC_API_KEY; everything
      // else uses <PROVIDER>_API_KEY, matching createProvider).
      if (msg.apiKey && provider !== "ollama") {
        const keyEnv = providerKeyEnv(provider);
        u.env[keyEnv] = msg.apiKey;
        process.env[keyEnv] = msg.apiKey; // force so the rebuilt provider uses the new key
      }
    }
    if (msg.voice) c.voice = { ...(c.voice ?? {}), provider: msg.voice };
    saveUserConfig(u);

    // Rebuild the effective config + provider live.
    this.config = await loadConfig(this.projectRoot);
    try {
      this.provider = createProvider(this.config);
      this.providerError = undefined;
    } catch (err) {
      this.provider = null;
      this.providerError = (err as Error).message;
    }
    const drafting = { provider: this.config.drafting.provider, model: this.config.drafting.model, baseUrl: this.config.drafting.baseUrl };
    console.log(`[heckle] drafting model set: ${drafting.provider} · ${drafting.model}${this.providerError ? ` (error: ${this.providerError})` : ""}`);
    reply({ type: "config", drafting, error: this.providerError });
    this.emit({ type: "config", drafting, error: this.providerError });
  }

  /** Current delivery selection (read by tests + sent to the widget). */
  get deliverySelection(): DeliverySelection {
    return this.selection;
  }

  /** Wire an async push channel to connected widgets (used to report fix completion). */
  setEmitter(fn: (msg: ServerMessage) => void): void {
    this.emit = fn;
  }

  /** Push one capture's latest state to live widgets so the task list re-renders that row. */
  private pushCapture(rec: CaptureRecord | undefined): void {
    if (rec) this.emit({ type: "capture", record: rec });
  }

  private handleTrigger(intentText: string, context: ContextBundle, reply: Reply, insist?: boolean): void {
    const trigger: StoredTrigger = {
      id: `trg_${randomUUID()}`,
      intentText,
      context,
      receivedAt: Date.now(),
      insist,
    };
    this.triggers.unshift(trigger);

    const stats = {
      console: context.console?.length ?? 0,
      network: context.network?.length ?? 0,
      rrweb: context.rrwebEvents?.length ?? 0,
    };

    this.persistLast(trigger);
    // Record the capture immediately (outcome updated as it drafts) so the task list can
    // always show what was captured, even when the model later declines.
    const record = captureRecordFrom(trigger, stats);
    this.captures.add(record);
    console.log(
      `[heckle] trigger ${trigger.id} "${truncate(intentText, 60)}", ` +
        `url=${context.url} console=${stats.console} network=${stats.network} ` +
        `rrweb=${stats.rrweb} dom=${context.domSnapshotId ?? "-"}`,
    );

    // Acknowledge capture immediately (the direct reply), then push the new task row to all live
    // widgets and draft asynchronously.
    this.metrics?.record("heckle_triggered", { triggerId: trigger.id });
    reply({ type: "ack", triggerId: trigger.id, stats });
    this.pushCapture(record);
    void this.draftAndReply(trigger, reply);
  }

  private async draftAndReply(trigger: StoredTrigger, reply: Reply): Promise<void> {
    if (!this.provider) {
      if (this.providerError) reply({ type: "error", message: this.providerError });
      return; // drafting explicitly disabled
    }
    try {
      // Recall prior related issues before drafting (feeds the model, and the hero moment).
      let related: RelatedIssue[] = [];
      if (this.memory) {
        try {
          related = await this.memory.recall(trigger.intentText);
        } catch (err) {
          console.warn(`[heckle] recall failed: ${(err as Error).message}`);
        }
      }

      const draft = await this.provider.draft({
        transcript: trigger.intentText,
        context: trigger.context,
        related: related.map((r) => r.issue),
        insist: trigger.insist,
      });

      // The model can decline: nothing actionable. Do not fabricate a task, do not touch memory.
      if (isNoIssue(draft)) {
        console.log(`[heckle] no issue for ${trigger.id}: ${draft.reason ?? "(no reason)"}`);
        this.pushCapture(this.captures.setOutcome(trigger.id, "noissue", { reason: draft.reason ?? "" }));
        reply({ type: "noissue", reason: draft.reason ?? "" });
        return;
      }

      const feedback: Feedback = { id: `fb_${randomUUID()}`, ...draft, history: null };

      // The hero moment: annotate against memory, then record/bump. Track the issue id so a
      // landed fix can later mark it fixed.
      let issueId: string | undefined;
      if (this.memory) {
        try {
          if (related.length > 0) {
            const top = related[0];
            const count = this.memory.bumpFlag(top.issue.id);
            feedback.history = historyFor(top.issue, count);
            issueId = top.issue.id;
          } else {
            const created = await this.memory.addIssue({
              summary: draft.intent,
              flow: draft.target.flow,
              contextRef: feedback.id,
            });
            issueId = created.id;
          }
        } catch (err) {
          console.warn(`[heckle] memory update failed: ${(err as Error).message}`);
        }
      }

      this.pending.set(feedback.id, { feedback, context: trigger.context, issueId, captureId: trigger.id, transcript: trigger.intentText });
      this.pushCapture(
        this.captures.setOutcome(trigger.id, "drafted", {
          feedbackId: feedback.id,
          intent: feedback.intent,
          severity: feedback.severity,
        }),
      );
      this.metrics?.record("draft_created", { feedbackId: feedback.id, severity: feedback.severity });
      console.log(
        `[heckle] drafted ${feedback.id} severity=${feedback.severity} ` +
          `refs=${feedback.context.consoleRefs.length}c/${feedback.context.networkRefs.length}n` +
          `${feedback.history ? ` history=${feedback.history.kind}` : ""} "${truncate(feedback.intent, 60)}"`,
      );
      // Attach the actual referenced console/network entries so the widget can show them.
      const conIds = new Set(feedback.context.consoleRefs);
      const netIds = new Set(feedback.context.networkRefs);
      reply({
        type: "draft",
        feedback,
        attachments: {
          console: (trigger.context.console ?? []).filter((e) => conIds.has(e.id)),
          network: (trigger.context.network ?? []).filter((e) => netIds.has(e.id)),
        },
      });
    } catch (err) {
      console.warn(`[heckle] drafting failed: ${(err as Error).message}`);
      this.pushCapture(this.captures.setOutcome(trigger.id, "error", { reason: (err as Error).message }));
      reply({ type: "error", message: `drafting failed: ${(err as Error).message}` });
    }
  }

  // The human-approval gate firing. The approval click is the gate; dispatching the
  // already-approved content is just transport, so it does not violate the principle.
  private async handleApprove(feedbackId: string, edited: Partial<Feedback> | undefined, reply: Reply): Promise<void> {
    const pending = this.pending.get(feedbackId);
    if (!pending) {
      reply({ type: "error", message: `no draft ${feedbackId} awaiting approval` });
      return;
    }
    const parsed = FeedbackSchema.safeParse(edited ? { ...pending.feedback, ...edited } : pending.feedback);
    if (!parsed.success) {
      reply({ type: "error", message: `invalid approved feedback: ${parsed.error.issues[0]?.message ?? "schema error"}` });
      return;
    }
    const feedback: Feedback = parsed.data;
    try {
      const artifact = createReproArtifact(
        this.projectRoot,
        feedback,
        pending.context,
        pending.issueId ?? `iss_${feedback.id}`,
        pending.transcript ?? feedback.intent,
      );
      const artifactPath = this.reproStore.save(artifact);
      if (this.captureGate) {
        const gate = await this.captureGate.gate(artifact, { runs: 3 });
        if (!gate.stable) console.warn(`[heckle] repro ${artifact.id} quarantined after capture gate`);
      }
      this.ledger?.recordRepro(artifact, artifactPath);
      this.ledger?.recordRoute(artifact.route);
      feedback.reproId = artifact.id;
      if (pending.captureId) this.pushCapture(this.captures.setOutcome(pending.captureId, "drafted", { reproId: artifact.id }));
    } catch (err) {
      reply({ type: "error", message: `could not create repro: ${(err as Error).message}` });
      return;
    }
    this.metrics?.record("draft_approved", { feedbackId });
    // Remember the issue so a completed Claude Code fix can mark it fixed (open -> fixed).
    if (pending.issueId) this.issueByFeedback.set(feedbackId, pending.issueId);
    // Emit the task context receipt: hashes and counts proving exactly WHICH captured context and
    // WHICH task text this approval covers, plus the dispatch posture it ships under. Written
    // before delivery so the inbox item's receipt reference points at a real file. Best-effort:
    // a receipt failure must never block the ship.
    try {
      const receiptPath = writeTaskContextReceipt(
        this.projectRoot,
        buildTaskContextReceipt({
          feedback,
          context: pending.context,
          transcript: pending.transcript,
          captureId: pending.captureId,
          localOnly: this.config.privacy.localOnly,
          dispatch: this.dispatchInfo(edited !== undefined),
        }),
      );
      console.log(`[heckle] receipt ${receiptPath}`);
    } catch (err) {
      console.warn(`[heckle] could not write receipt: ${(err as Error).message}`);
    }
    try {
      const results = await this.delivery.deliver(feedback, pending.context);
      // Did a real agent adapter actually fire? Only then is a fix running (and only then will a
      // fixStatus follow); an inbox-only route just filed the item, so it must not show "working".
      const dispatched = results.some((r) => r.ok && isDispatchAdapter(r.adapter));
      if (pending.captureId) {
        this.pushCapture(
          this.captures.setOutcome(pending.captureId, "delivered", dispatched ? { dispatchedAt: Date.now() } : {}),
        );
        // Remember the link so the async fix-progress/completion callbacks can update this record.
        if (dispatched) this.captureByFeedback.set(feedbackId, pending.captureId);
      }
      this.delivered.set(feedbackId, { ...pending, feedback });
      this.pending.delete(feedbackId);
      console.log(
        `[heckle] delivered ${feedbackId}: ${results.map((r) => `${r.adapter}:${r.ok ? "ok" : "fail"}`).join(" ")}`,
      );
      reply({ type: "delivered", feedbackId, results });
    } catch (err) {
      reply({ type: "error", message: `delivery failed: ${(err as Error).message}` });
    }
  }

  // Run an item that is sitting in the inbox (or that a prior run did not land) with the agent,
  // straight from the panel, so Heckle is self-contained (no "check Heckle" in a terminal). The
  // item already lives in .heckle/inbox.md, so a minimal reconstructed Feedback is enough: the
  // fix prompt tells the agent to read that file and fix this id.
  private async handleRun(captureId: string, reply: Reply): Promise<void> {
    const rec = this.captures.list().find((r) => r.id === captureId);
    if (!rec || !rec.feedbackId) {
      reply({ type: "error", message: `nothing to run for ${captureId}` });
      return;
    }
    if (rec.outcome === "delivered" && rec.dispatchedAt) return; // already running

    const feedback: Feedback = {
      id: rec.feedbackId,
      intent: rec.intent ?? rec.transcript,
      target: { flow: rec.flow },
      severity: (rec.severity as Feedback["severity"]) ?? "bug",
      repro: [],
      context: { consoleRefs: [], networkRefs: [] },
      history: null,
    };
    const context: ContextBundle = { url: rec.url, console: [], network: [], capturedAt: rec.ts };
    // Run with the gear's agent; if it is set to Inbox-only, default to Claude Code (the user
    // explicitly asked to run this item, so honour that over the passive inbox routing).
    const agent = this.selection.agent === "inbox" ? "claude-code" : this.selection.agent;
    const chain = createDeliveryChain(
      selectionToConfig(this.config, { agent, session: this.selection.session, autonomy: this.selection.autonomy }),
      this.deliveryDeps,
    );

    // Show it running immediately, then dispatch.
    this.pushCapture(this.captures.setOutcome(captureId, "delivered", { dispatchedAt: Date.now(), progress: undefined }));
    this.captureByFeedback.set(feedback.id, captureId);
    try {
      const results = await chain.deliver(feedback, context);
      const dispatched = results.some((r) => r.ok && isDispatchAdapter(r.adapter));
      if (!dispatched) {
        // No agent CLI available: revert to the inbox state and say so.
        this.captureByFeedback.delete(feedback.id);
        this.pushCapture(this.captures.setOutcome(captureId, "delivered", { dispatchedAt: undefined }));
        reply({ type: "error", message: `no agent available to run this (install the CLI, or pick one in the gear)` });
        return;
      }
      console.log(`[heckle] run ${captureId} via ${agent}`);
      reply({ type: "delivered", feedbackId: feedback.id, results });
    } catch (err) {
      this.captureByFeedback.delete(feedback.id);
      this.pushCapture(this.captures.setOutcome(captureId, "failed", { dispatchedAt: undefined }));
      reply({ type: "error", message: `run failed: ${(err as Error).message}` });
    }
  }

  // Remove a row: drop the capture record, any un-approved draft, and the item from the inbox
  // file, so nothing later acts on it. Refuses while an agent is actively running it.
  private handleRemove(captureId: string, reply: Reply): void {
    const rec = this.captures.list().find((r) => r.id === captureId);
    if (!rec) return; // already gone
    if (rec.outcome === "delivered" && rec.dispatchedAt) {
      reply({ type: "error", message: "the agent is running this one; wait for it to finish, then remove it" });
      return;
    }
    this.captures.remove(captureId);
    if (rec.reproId) new ReproStore(this.projectRoot).remove(rec.reproId);
    if (rec.feedbackId) {
      this.pending.delete(rec.feedbackId); // if it was an un-approved draft
      removeInboxItem(this.projectRoot, rec.feedbackId); // take it out of .heckle/inbox.md
      removeTaskContextReceipt(this.projectRoot, rec.feedbackId); // and its receipt with it
    }
    this.emit({ type: "removed", captureId });
    console.log(`[heckle] removed ${captureId}`);
  }

  // The dispatch posture for the receipt: the routed agent plus the effective session/permission
  // knobs the DeliveryChain hands it. Fallback values mirror the adapter constructor defaults.
  private dispatchInfo(userEdited: boolean): ReceiptDispatchInfo {
    const agent = this.selection.agent;
    if (agent === "inbox") return { agent, userEdited };
    const eff = selectionToConfig(this.config, this.selection).delivery;
    if (agent === "claude-code") {
      return {
        agent,
        userEdited,
        sessionMode: eff.claudeCode?.session ?? "persistent",
        permissionMode: eff.claudeCode?.permissionMode ?? "acceptEdits",
        allowedTools: eff.claudeCode?.allowedTools ?? [],
      };
    }
    if (agent === "cursor") {
      return { agent, userEdited, sessionMode: eff.cursor?.session ?? "persistent" };
    }
    return {
      agent,
      userEdited,
      sessionMode: eff.codex?.session ?? "fresh",
      permissionMode: `ask-for-approval:${eff.codex?.askForApproval ?? "never"}`,
      sandbox: eff.codex?.sandbox ?? "workspace-write",
    };
  }

  private persistLast(trigger: StoredTrigger): void {
    try {
      mkdirSync(this.heckleDir, { recursive: true });
      writeFileSync(resolve(this.heckleDir, "last-trigger.json"), JSON.stringify(trigger, null, 2));
    } catch (err) {
      console.warn(`[heckle] could not persist trigger: ${(err as Error).message}`);
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

const HIST_ENTRIES = 12; // console/network lines kept per capture record

// Build the initial history record for a capture (outcome filled in as it drafts).
function captureRecordFrom(
  trigger: StoredTrigger,
  stats: { console: number; network: number; rrweb: number },
): CaptureRecord {
  const ctx = trigger.context;
  // Guard the arrays like the stats code does: this runs synchronously in the ws handler, so
  // a trigger with a trimmed context must degrade to an empty record, not crash the daemon.
  return {
    id: trigger.id,
    ts: trigger.receivedAt,
    url: ctx.url,
    flow: ctx.flow,
    transcript: trigger.intentText,
    selection: ctx.selection,
    console: (ctx.console ?? [])
      .slice(-HIST_ENTRIES)
      .map((e) => ({ level: e.level, text: e.args.join(" ").slice(0, 200) })),
    network: (ctx.network ?? [])
      .slice(-HIST_ENTRIES)
      .map((e) => ({ method: e.method, url: e.url, status: e.status, ok: e.ok })),
    stats,
    outcome: "capturing",
  };
}
