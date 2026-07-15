import type { ReproArtifact } from "../../shared/src/index.ts";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";

export class ReproStore {
  readonly projectRoot: string;
  readonly reproDir: string;
  readonly fixtureDir: string;

  constructor(projectRoot: string = process.cwd()) {
    this.projectRoot = projectRoot;
    this.reproDir = resolve(projectRoot, ".heckle", "repros");
    this.fixtureDir = resolve(this.reproDir, "fixtures");
    mkdirSync(this.fixtureDir, { recursive: true });
  }

  save(artifact: ReproArtifact): string {
    const path = resolve(this.reproDir, `${artifact.id}.json`);
    writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
    return path;
  }

  load(id: string): ReproArtifact | undefined {
    if (!/^hkl_[\w-]+$/.test(id)) return undefined;
    const path = resolve(this.reproDir, `${id}.json`);
    if (!existsSync(path)) return undefined;
    const artifact = JSON.parse(readFileSync(path, "utf8")) as ReproArtifact;
    if (artifact.version !== 1) throw new Error(`unsupported repro schema version: ${artifact.version}`);
    return artifact;
  }

  remove(id: string): void {
    if (!/^hkl_[\w-]+$/.test(id)) return;
    const artifact = this.load(id);
    if (!artifact) return;
    for (const fixture of artifact.network_fixtures) {
      const path = resolve(this.reproDir, fixture.body_ref);
      if (path.startsWith(this.fixtureDir + sep)) rmSync(path, { force: true });
    }
    rmSync(resolve(this.reproDir, `${id}.json`), { force: true });
  }

  list(): ReproArtifact[] {
    if (!existsSync(this.reproDir)) return [];
    return readdirSync(this.reproDir)
      .filter((file) => /^hkl_[\w-]+\.json$/.test(file))
      .map((file) => this.load(file.slice(0, -5)))
      .filter((artifact): artifact is ReproArtifact => artifact !== undefined)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  saveFixture(name: string, body: string, contentType?: string): string {
    const safe = name.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const path = resolve(this.fixtureDir, safe);
    writeFileSync(path, JSON.stringify({ body, contentType }));
    return `fixtures/${safe}`;
  }

  loadFixture(reference: string): { body: string; contentType?: string } | undefined {
    const path = resolve(this.reproDir, reference);
    if (!path.startsWith(this.fixtureDir + sep) || !existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as { body: string; contentType?: string };
  }
}
