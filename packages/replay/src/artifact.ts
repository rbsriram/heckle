import type {
  ContextBundle,
  Feedback,
  ReproAction,
  ReproArtifact,
  ReproAssertion,
  ReproNetworkFixture,
  ReproTarget,
} from "../../shared/src/index.ts";
import { randomUUID } from "node:crypto";
import { ReproStore } from "./store.ts";

function interactionRoot(css: string): string {
  const parts = css.split(" > ");
  return parts.slice(0, Math.max(1, parts.length - 1)).join(" > ");
}

function trimActions(actions: ReproAction[], url: URL, selected?: ReproTarget): ReproAction[] {
  let start = 0;
  for (let index = actions.length - 1; index >= 0; index--) {
    if (actions[index].type === "goto") {
      start = index;
      break;
    }
  }
  let trimmed = actions.slice(start).map((action) => structuredClone(action));
  if (selected?.css) {
    const selectedRoot = interactionRoot(selected.css);
    trimmed = trimmed.filter((action) => {
      if (action.type === "goto") return true;
      if (!action.target.css) return true;
      const actionRoot = interactionRoot(action.target.css);
      return actionRoot.startsWith(selectedRoot) || selectedRoot.startsWith(actionRoot);
    });
  }
  const first = trimmed[0];
  if (first?.type === "goto") first.url = `${url.pathname}${url.search}${url.hash}`;
  else trimmed.unshift({ type: "goto", url: `${url.pathname}${url.search}${url.hash}`, ts: Date.now() });
  return trimmed;
}

function fallbackAssertions(context: ContextBundle): ReproAssertion[] {
  const assertions: ReproAssertion[] = [];
  if (context.console.some((entry) => entry.level === "error")) {
    assertions.push({ type: "console_clean", levels: ["error"] });
  }
  if (context.network.some((entry) => entry.ok === false || (entry.status ?? 0) >= 400)) {
    assertions.push({ type: "no_failed_requests", exclude: ["analytics", "source-map"] });
  }
  return assertions;
}

export function createReproArtifact(
  projectRoot: string,
  feedback: Feedback,
  context: ContextBundle,
  issueId: string,
  utterance: string,
): ReproArtifact {
  const url = new URL(context.url);
  const id = `hkl_${randomUUID()}`;
  const store = new ReproStore(projectRoot);
  const actions = trimActions(context.actions ?? [], url, context.selection?.target);
  const assertions = feedback.assertions?.length ? feedback.assertions : fallbackAssertions(context);
  const elements = new Set<string>();
  for (const action of actions) {
    if (action.type === "goto") continue;
    const target = action.target;
    if (target.testid) elements.add(`testid:${target.testid}`);
    else if (target.role && target.name) elements.add(`role:${target.role}:${target.name}`);
    else if (target.css) elements.add(`css:${target.css}`);
  }
  for (const assertion of assertions) {
    if (assertion.type !== "text_equals") continue;
    const target = assertion.target;
    if (target.testid) elements.add(`testid:${target.testid}`);
    else if (target.role && target.name) elements.add(`role:${target.role}:${target.name}`);
    else if (target.css) elements.add(`css:${target.css}`);
  }
  const networkFixtures: ReproNetworkFixture[] = context.network
    .filter((entry) => entry.status !== undefined && entry.responseBody !== undefined)
    .filter((entry) => new URL(entry.url, url.origin).origin === url.origin)
    .filter((entry) => !/\.(?:js|css|map|png|jpe?g|gif|svg|ico|woff2?)(?:\?|$)/i.test(entry.url))
    .map((entry, index) => {
      const target = new URL(entry.url, url.origin);
      const contentType = entry.responseHeaders?.["content-type"];
      const bodyRef = store.saveFixture(`${id}_${index}.json`, entry.responseBody ?? "", contentType);
      return {
        match: `${entry.method.toUpperCase()} ${target.pathname}${target.search}`,
        method: entry.method.toUpperCase(),
        status: entry.status ?? 200,
        body_ref: bodyRef,
        headers: contentType ? { "content-type": contentType } : undefined,
        recorded_at: new Date(entry.ts).toISOString(),
      };
    });
  return {
    version: 1,
    id,
    issue_id: issueId,
    created_at: new Date().toISOString(),
    origin: url.origin,
    route: `${url.pathname}${url.search}${url.hash}`,
    viewport: context.viewport ?? { width: 1280, height: 720 },
    state_seed: context.stateSeed ?? { localStorage: {}, sessionStorage: {}, cookies: [] },
    actions,
    network_fixtures: networkFixtures,
    assertions,
    utterance,
    determinism: { runs: 0, pass_rate: 0, quarantined: false, outcomes: [] },
    surfaces: {
      routes: [`${url.pathname}${url.search}${url.hash}`],
      files: [],
      elements: [...elements],
    },
  };
}
