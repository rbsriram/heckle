// Local embeddings for semantic recall. nomic-embed-text via Ollama; cosine in JS, no
// sqlite-vec needed at v0 scale.

export interface Embedder {
  embed(text: string): Promise<Float32Array>;
}

export class OllamaEmbedder implements Embedder {
  private readonly url: string;
  private readonly model: string;

  constructor(opts: { baseUrl: string; model: string }) {
    const host = opts.baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
    this.url = `${host}/api/embeddings`;
    this.model = opts.model;
  }

  async embed(text: string): Promise<Float32Array> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });
    if (!res.ok) throw new Error(`ollama embeddings HTTP ${res.status}`);
    const json = (await res.json()) as { embedding?: number[] };
    if (!json.embedding) throw new Error("ollama returned no embedding");
    return Float32Array.from(json.embedding);
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
