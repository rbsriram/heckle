// Ambient auto-attach for Vite projects. Add `heckle()` to your vite.config plugins and
// the widget injects itself into the dev server's HTML whenever you run under `heckle dev`
// (which sets HECKLE_DAEMON_URL). No separate step; if Heckle isn't running, nothing injects.
// No `vite` import, we only return Vite's plugin shape, consumed by the user's Vite.

interface IndexHtmlTag {
  tag: string;
  attrs?: Record<string, string>;
  injectTo?: "head" | "body" | "head-prepend" | "body-prepend";
}

interface VitePluginLike {
  name: string;
  apply?: "serve" | "build";
  transformIndexHtml: (html: string) => { html: string; tags: IndexHtmlTag[] };
}

export function heckle(opts: { daemonUrl?: string } = {}): VitePluginLike {
  const daemonUrl = opts.daemonUrl ?? process.env.HECKLE_DAEMON_URL ?? "http://127.0.0.1:4317";
  return {
    name: "heckle",
    apply: "serve", // dev only, never inject into production builds
    transformIndexHtml(html) {
      return {
        html,
        tags: [{ tag: "script", attrs: { src: `${daemonUrl}/heckle.js` }, injectTo: "body" }],
      };
    },
  };
}

export default heckle;
