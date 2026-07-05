// Records the mic in the browser and returns a 16 kHz mono WAV blob. This is decoupled
// from DOM focus, so you can talk while you click around the app. The blob goes to the
// daemon's /transcribe, which runs your local Parakeet model. Nothing leaves the machine.

export interface Recorder {
  readonly recording: boolean;
  start(): Promise<void>;
  stop(): Promise<Blob>;
}

export function createRecorder(): Recorder {
  let media: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let chunks: BlobPart[] = [];
  let recording = false;

  return {
    get recording() {
      return recording;
    },
    async start() {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      media = new MediaRecorder(stream);
      media.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      media.start();
      recording = true;
    },
    stop(): Promise<Blob> {
      return new Promise((resolvePromise, reject) => {
        const m = media;
        if (!m) return reject(new Error("not recording"));
        m.onstop = async () => {
          recording = false;
          stream?.getTracks().forEach((t) => t.stop());
          try {
            resolvePromise(await toWav16kMono(new Blob(chunks, { type: m.mimeType || "audio/webm" })));
          } catch (err) {
            reject(err as Error);
          }
        };
        m.stop();
      });
    },
  };
}

async function toWav16kMono(blob: Blob): Promise<Blob> {
  const bytes = await blob.arrayBuffer();
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const decodeCtx = new AC();
  const decoded = await decodeCtx.decodeAudioData(bytes);
  await decodeCtx.close();

  // OfflineAudioContext with 1 channel downmixes; rendering at 16 kHz resamples.
  const frames = Math.max(1, Math.ceil(decoded.duration * 16000));
  const offline = new OfflineAudioContext(1, frames, 16000);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return encodeWav(rendered.getChannelData(0), 16000);
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([view], { type: "audio/wav" });
}
