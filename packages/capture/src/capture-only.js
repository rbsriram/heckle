(() => {
  if (window.__heckleCaptureOnly) return;
  window.__heckleCaptureOnly = true;
  const script = document.currentScript;
  const project = script?.dataset.project || location.hostname;
  const configuredReporter = script?.dataset.reporter || "";
  const consoleErrors = [];
  const failedRequests = [];
  const actions = [];
  const redact = (value) => String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/\b(api[-_]?key|token|password|session|secret)=([^&\s]+)/gi, "$1=[REDACTED]")
    .replace(/\+?\d[\d ().-]{8,}\d/g, "[REDACTED_PHONE]")
    .slice(0, 500);
  const originalError = console.error.bind(console);
  console.error = (...args) => {
    consoleErrors.push(redact(args.join(" ")));
    if (consoleErrors.length > 20) consoleErrors.shift();
    originalError(...args);
  };
  addEventListener("error", (event) => {
    consoleErrors.push(redact(event.message));
    if (consoleErrors.length > 20) consoleErrors.shift();
  });
  addEventListener("unhandledrejection", (event) => {
    consoleErrors.push(redact(event.reason instanceof Error ? event.reason.message : event.reason));
    if (consoleErrors.length > 20) consoleErrors.shift();
  });
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (response.status >= 400 && new URL(response.url, location.href).origin === location.origin) {
      failedRequests.push(`${response.status} ${new URL(response.url).pathname}`);
      if (failedRequests.length > 20) failedRequests.shift();
    }
    return response;
  };
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__heckleRequest = { method, url: String(url) };
    return open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("loadend", () => {
      const request = this.__heckleRequest;
      if (request && this.status >= 400) {
        const url = new URL(request.url, location.href);
        if (url.origin === location.origin) {
          failedRequests.push(`${this.status} ${url.pathname}`);
          if (failedRequests.length > 20) failedRequests.shift();
        }
      }
    }, { once: true });
    return send.apply(this, args);
  };
  addEventListener("click", (event) => {
    const element = event.target instanceof Element ? event.target : null;
    if (!element || element.closest("#heckle-capture-only")) return;
    actions.push(`Click ${redact(element.getAttribute("aria-label") || element.textContent || element.tagName)}`);
    if (actions.length > 20) actions.shift();
  }, true);

  const host = document.createElement("div");
  host.id = "heckle-capture-only";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>
    button{position:fixed;right:20px;bottom:20px;z-index:2147483647;border:0;border-radius:50%;width:42px;height:42px;background:#111;color:#ff6a3d;font:800 21px system-ui;cursor:pointer}
    form{position:fixed;right:20px;bottom:72px;z-index:2147483647;width:300px;padding:14px;border-radius:14px;background:#111;color:#fff;font:13px system-ui;box-shadow:0 8px 30px #0006;display:none}
    form.open{display:block} textarea,input{width:100%;padding:9px;border-radius:8px;border:1px solid #555;background:#222;color:#fff} textarea{min-height:90px;resize:vertical} input{margin:8px 0}.row{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}.row button{position:static;width:auto;height:auto;border-radius:7px;padding:7px 10px;color:#fff;background:#444;font:12px system-ui}.row button[type=submit]{background:#e65435}
  </style><button id="launch" aria-label="File a Heckle">h</button><form id="form"><strong>What is broken?</strong>${configuredReporter ? "" : '<input id="reporter" placeholder="Reporter id" maxlength="80" required />'}<textarea id="note" required></textarea><div class="row"><button type="button" id="cancel">Cancel</button><button type="submit">Export Heckle</button></div></form>`;
  document.body.appendChild(host);
  const form = shadow.querySelector("#form");
  const note = shadow.querySelector("#note");
  shadow.querySelector("#launch").onclick = () => { form.classList.add("open"); note.focus(); };
  shadow.querySelector("#cancel").onclick = () => form.classList.remove("open");
  form.onsubmit = (event) => {
    event.preventDefault();
    const payload = {
      schema: "heckle-capture@1",
      project,
      reporter: configuredReporter || shadow.querySelector("#reporter")?.value.trim() || "anonymous",
      source: "capture-only",
      created_at: new Date().toISOString(),
      route: `${location.pathname}${location.search}${location.hash}`,
      origin: location.origin,
      intent: redact(note.value),
      repro: [...actions],
      evidence: { console_errors: [...consoleErrors], failed_requests: [...failedRequests] },
    };
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `heckle-${Date.now()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    note.value = "";
    form.classList.remove("open");
  };
})();
