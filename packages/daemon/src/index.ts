// Library surface of @heckle/daemon (no side effects on import).
// The runnable entry point is ./main.ts.
export { startDaemon, type DaemonHandle } from "./server.ts";
export { loadConfig, DEFAULT_CONFIG, loadUserConfig, saveUserConfig, userConfigPath, type UserConfig } from "./config.ts";
export { createMetrics, openMetrics, formatMetrics, Metrics, type MetricsSummary } from "./metrics.ts";
export { startInjectingProxy, injectSnippet, type InjectingProxyOptions } from "./proxy.ts";
// Re-exported so the CLI (which depends on @heckle/daemon) shares one source for provider config.
export { DRAFTING_PRESETS, providerKeyEnv, type DraftingPreset } from "@heckle/providers";
