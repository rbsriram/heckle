// Local voice: the STT worker + transcribe path. Uses macOS `say` to synthesize speech,
// then transcribes it through the real Parakeet worker. Gated on macOS + a built worker,
// so the suite stays green elsewhere (run `npm run stt:build` first to exercise this).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createStt } from "../src/stt.ts";

const STT_BIN = fileURLToPath(new URL("../../../stt/.build/release/heckle-stt", import.meta.url));
const runnable = process.platform === "darwin" && existsSync(STT_BIN);

test(
  "local STT transcribes synthesized speech via the reused Parakeet model",
  { skip: runnable ? false : "needs macOS + built worker (npm run stt:build)", timeout: 60_000 },
  async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "heckle-stt-test-"));
    const wav = resolve(dir, "phrase.wav");
    execFileSync("say", ["-o", wav, "--data-format=LEI16@16000", "the checkout total is wrong"]);

    const stt = createStt();
    try {
      assert.equal(stt.available, true);
      const text = (await stt.transcribe(readFileSync(wav))).toLowerCase();
      assert.match(text, /checkout|total|wrong/);
    } finally {
      stt.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
