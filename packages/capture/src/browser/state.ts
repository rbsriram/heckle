import type { ReproStateSeed } from "../../../shared/src/index.ts";

const SENSITIVE_KEY = /(?:auth|token|secret|password|passwd|session|cookie|jwt|api[-_]?key|email)/i;

function storageSnapshot(storage: Storage): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key !== null && !key.startsWith("__heckle_") && !SENSITIVE_KEY.test(key)) {
      result[key] = storage.getItem(key) ?? "";
    }
  }
  return result;
}

export function captureStateSeed(): ReproStateSeed {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { localStorage: {}, sessionStorage: {}, cookies: [] };
  }
  const cookies = document.cookie
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !SENSITIVE_KEY.test(part.split("=", 1)[0]))
    .map((part) => {
      const separator = part.indexOf("=");
      return {
        name: separator === -1 ? part : part.slice(0, separator),
        value: separator === -1 ? "" : part.slice(separator + 1),
        domain: location.hostname,
        path: "/",
      };
    });
  return {
    localStorage: storageSnapshot(localStorage),
    sessionStorage: storageSnapshot(sessionStorage),
    cookies,
  };
}
