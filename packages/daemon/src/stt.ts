// Local speech-to-text: manages the persistent heckle-stt Swift worker (FluidAudio +
// your existing Parakeet model). The worker loads the model once and transcribes each
// clip in ~0.1s over a stdin/stdout path->transcript protocol. Nothing leaves the machine.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STT_BIN = fileURLToPath(new URL("../../../stt/.build/release/heckle-stt", import.meta.url));
const TRANSCRIBE_TIMEOUT_MS = 20_000;

export interface Stt {
  readonly available: boolean;
  transcribe(wav: Buffer): Promise<string>;
  close(): void;
}

export function createStt(opts: { enabled?: boolean } = {}): Stt {
  const enabled = opts.enabled ?? true;
  if (!enabled || !existsSync(STT_BIN)) {
    return {
      available: false,
      async transcribe() {
        throw new Error(
          enabled
            ? "local STT not built (run: npm run stt:build)"
            : "local STT only runs when voice.provider is 'local'",
        );
      },
      close() {},
    };
  }

  const tmp = mkdtempSync(resolve(tmpdir(), "heckle-stt-"));
  let child: ChildProcess | null = null;
  let ready = false;
  let readyWaiters: Array<() => void> = [];
  const queue: Array<(line: string) => void> = [];
  let buf = "";

  const start = () => {
    child = spawn(STT_BIN, ["--serve"], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!ready && line.trim() === "READY") {
          ready = true;
          console.log("[heckle] local STT ready");
          for (const w of readyWaiters) w();
          readyWaiters = [];
        } else {
          queue.shift()?.(line);
        }
      }
    });
    child.stderr?.on("data", (d: Buffer) => console.warn(`[heckle] stt: ${d.toString().trim()}`));
    child.on("exit", () => {
      ready = false;
      child = null;
      // Fail any in-flight request so callers do not hang.
      while (queue.length) queue.shift()?.("");
    });
  };
  start(); // warm the model as soon as the daemon boots

  const waitReady = () =>
    ready ? Promise.resolve() : new Promise<void>((res) => readyWaiters.push(res));

  // One worker, one clip at a time.
  let chain: Promise<unknown> = Promise.resolve();

  const runOne = async (wav: Buffer): Promise<string> => {
    if (!child) start();
    await waitReady();
    const file = resolve(tmp, `clip-${randomUUID()}.wav`);
    writeFileSync(file, wav);
    try {
      return await new Promise<string>((res, rej) => {
        const timer = setTimeout(() => rej(new Error("transcription timed out")), TRANSCRIBE_TIMEOUT_MS);
        queue.push((line) => {
          clearTimeout(timer);
          res(line);
        });
        child?.stdin?.write(`${file}\n`);
      });
    } finally {
      try {
        rmSync(file, { force: true });
      } catch {
        // best effort
      }
    }
  };

  return {
    available: true,
    transcribe(wav: Buffer): Promise<string> {
      const p = chain.then(() => runOne(wav));
      chain = p.catch(() => {}); // keep the chain alive even if one clip fails
      return p;
    },
    close() {
      try {
        child?.stdin?.end();
        child?.kill();
      } catch {
        // already gone
      }
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}
