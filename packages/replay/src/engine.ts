import type { ReproArtifact, ReproAssertion, ReproTarget } from "../../shared/src/index.ts";
import { chromium, type Locator, type Page } from "playwright";
import { ReproStore } from "./store.ts";

export interface AssertionResult {
  assertion: ReproAssertion;
  passed: boolean;
  actual?: string;
  error?: string;
}

export interface ReplayResult {
  reproId: string;
  passed: boolean;
  durationMs: number;
  assertions: AssertionResult[];
  consoleErrors: string[];
  failedRequests: Array<{ method: string; url: string; status: number }>;
  error?: string;
}

function locatorFor(page: Page, target: ReproTarget): Locator {
  if (target.testid) return page.getByTestId(target.testid);
  if (target.role && target.name) return page.getByRole(target.role as Parameters<Page["getByRole"]>[0], { name: target.name });
  if (target.css) return page.locator(target.css);
  throw new Error("repro target has no usable selector");
}

function targetUrl(origin: string, value: string): string {
  return new URL(value, origin).href;
}

export class ReplayEngine {
  private readonly store: ReproStore;

  constructor(store: ReproStore) {
    this.store = store;
  }

  async run(artifact: ReproArtifact, options: { live?: boolean; headed?: boolean; origin?: string } = {}): Promise<ReplayResult> {
    const started = Date.now();
    let browser;
    try {
      browser = await chromium.launch({ headless: !options.headed });
    } catch (err) {
      throw new Error(`Chromium is not installed for Heckle replay. Run \`npx playwright@1.61.1 install chromium\`. ${(err as Error).message}`);
    }
    const origin = options.origin ?? artifact.origin;
    const context = await browser.newContext({ viewport: artifact.viewport });
    if (artifact.state_seed.cookies.length) await context.addCookies(artifact.state_seed.cookies);
    await context.addInitScript(
      ({ local, session }) => {
        for (const [key, value] of Object.entries(local)) localStorage.setItem(key, value);
        for (const [key, value] of Object.entries(session)) sessionStorage.setItem(key, value);
      },
      { local: artifact.state_seed.localStorage, session: artifact.state_seed.sessionStorage },
    );
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    const failedRequests: Array<{ method: string; url: string; status: number }> = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        failedRequests.push({ method: response.request().method(), url: response.url(), status: response.status() });
      }
    });

    if (!options.live && artifact.network_fixtures.length) {
      await page.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const key = `${request.method()} ${url.pathname}${url.search}`;
        const fixture = artifact.network_fixtures.find((candidate) => candidate.match === key);
        if (!fixture) return route.continue();
        const body = this.store.loadFixture(fixture.body_ref);
        if (!body) return route.continue();
        await route.fulfill({
          status: fixture.status,
          headers: fixture.headers ?? (body.contentType ? { "content-type": body.contentType } : undefined),
          body: body.body,
        });
      });
    }

    const assertionResults: AssertionResult[] = [];
    let error: string | undefined;
    try {
      for (const action of artifact.actions) {
        if (action.type === "goto") await page.goto(targetUrl(origin, action.url), { waitUntil: "domcontentloaded", timeout: 10_000 });
        else if (action.type === "click") await locatorFor(page, action.target).click({ timeout: 10_000 });
        else if (action.type === "fill") await locatorFor(page, action.target).fill(action.value, { timeout: 10_000 });
        else if (action.type === "press") await locatorFor(page, action.target).press(action.value, { timeout: 10_000 });
        else if (action.type === "select") await locatorFor(page, action.target).selectOption(action.value, { timeout: 10_000 });
        else await locatorFor(page, action.target).setChecked(action.checked, { timeout: 10_000 });
      }
      for (const assertion of artifact.assertions) {
        if (assertion.type === "text_equals") {
          const locator = locatorFor(page, assertion.target);
          let actual = "";
          const deadline = Date.now() + 5_000;
          do {
            actual = (await locator.textContent())?.trim() ?? "";
            if (actual === assertion.expected) break;
            await new Promise((resolveWait) => setTimeout(resolveWait, 50));
          } while (Date.now() < deadline);
          assertionResults.push({ assertion, passed: actual === assertion.expected, actual });
        } else if (assertion.type === "attribute_contains") {
          const actual = await locatorFor(page, assertion.target).getAttribute(assertion.attribute) ?? "";
          assertionResults.push({ assertion, passed: actual.split(/\s+/).includes(assertion.expected), actual });
        } else if (assertion.type === "attribute_present") {
          const actual = await locatorFor(page, assertion.target).getAttribute(assertion.attribute);
          assertionResults.push({ assertion, passed: (actual !== null) === assertion.expected, actual: actual ?? undefined });
        } else if (assertion.type === "style_equals") {
          const actual = await locatorFor(page, assertion.target).evaluate((element, property) => {
            const style = (element as HTMLElement).style;
            return style.getPropertyValue(property).trim() || String((style as unknown as Record<string, string>)[property] ?? "").trim();
          }, assertion.property);
          assertionResults.push({ assertion, passed: actual === assertion.expected, actual });
        } else if (assertion.type === "child_text_order") {
          const actual = await locatorFor(page, assertion.target).evaluate((element) => [...element.children].map((child) => (child.textContent ?? "").trim().replace(/\s+/g, " ")));
          assertionResults.push({ assertion, passed: JSON.stringify(actual) === JSON.stringify(assertion.expected), actual: JSON.stringify(actual) });
        } else if (assertion.type === "console_clean") {
          const passed = assertion.levels.includes("error") ? consoleErrors.length === 0 : true;
          assertionResults.push({ assertion, passed, error: passed ? undefined : consoleErrors.join("\n") });
        } else {
          const failures = failedRequests.filter(
            (failure) => !assertion.exclude.some((pattern) => failure.url.includes(pattern)),
          );
          assertionResults.push({
            assertion,
            passed: failures.length === 0,
            error: failures.length ? failures.map((failure) => `${failure.method} ${failure.url} -> ${failure.status}`).join("\n") : undefined,
          });
        }
      }
    } catch (err) {
      error = (err as Error).message;
    } finally {
      await context.close();
      await browser.close();
    }
    return {
      reproId: artifact.id,
      passed: !error && assertionResults.every((result) => result.passed),
      durationMs: Date.now() - started,
      assertions: assertionResults,
      consoleErrors,
      failedRequests,
      error,
    };
  }

  async gate(
    artifact: ReproArtifact,
    options: { live?: boolean; headed?: boolean; origin?: string; runs?: number } = {},
  ): Promise<{ stable: boolean; results: ReplayResult[] }> {
    const count = options.runs ?? 3;
    const results: ReplayResult[] = [];
    for (let index = 0; index < count; index++) results.push(await this.run(artifact, options));
    const outcomes = results.map((result) => result.passed);
    const stable = outcomes.length === count && outcomes.every(Boolean);
    artifact.determinism = {
      runs: outcomes.length,
      pass_rate: outcomes.filter(Boolean).length / outcomes.length,
      quarantined: !stable,
      outcomes,
      last_run_at: new Date().toISOString(),
    };
    this.store.save(artifact);
    return { stable, results };
  }
}
