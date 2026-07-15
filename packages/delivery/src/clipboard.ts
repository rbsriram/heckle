// The backstop. Puts the structured feedback on the clipboard for manual paste. Never the
// preferred path, but it works everywhere and never fails silently.
import type { ContextBundle, DeliveryResult, Feedback } from "../../shared/src/index.ts";
import { spawn as nodeSpawn } from "node:child_process";
import { formatFeedbackMarkdown } from "./format.ts";
import type { DeliveryAdapter, SpawnFn } from "./types.ts";

const defaultSpawn: SpawnFn = (cmd, args, opts) => nodeSpawn(cmd, [...args], opts);

export class ClipboardAdapter implements DeliveryAdapter {
  readonly name = "clipboard" as const;
  private readonly spawnFn: SpawnFn;

  constructor(opts: { spawnFn?: SpawnFn } = {}) {
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
  }

  async isAvailable(): Promise<boolean> {
    return process.platform === "darwin"; // pbcopy
  }

  async deliver(feedback: Feedback, context: ContextBundle): Promise<DeliveryResult> {
    const md = formatFeedbackMarkdown(feedback, context);
    return new Promise<DeliveryResult>((resolvePromise) => {
      try {
        const child = this.spawnFn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
        child.on?.("error", (err: unknown) =>
          resolvePromise({ adapter: this.name, ok: false, detail: (err as Error).message }),
        );
        child.on?.("close", (code: unknown) =>
          resolvePromise({ adapter: this.name, ok: code === 0, detail: code === 0 ? "copied" : `pbcopy exit ${code}` }),
        );
        child.stdin?.end(md);
      } catch (err) {
        resolvePromise({ adapter: this.name, ok: false, detail: (err as Error).message });
      }
    });
  }
}
