// Map the widget's high-level delivery choice (agent + session + autonomy) onto the detailed
// per-agent delivery config the DeliveryChain consumes, and back again so the gear can show the
// daemon's current state. Keeps all the "which knob means what per agent" logic in one place.
import { isDispatchAdapter } from "../../delivery/src/index.ts";
import type { DeliveryAdapterName, DeliverySelection, HeckleConfig } from "../../shared/src/index.ts";

// Apply a selection over the boot config, returning a config whose delivery routes accordingly.
// The gear only chooses which agent leads and the session/autonomy knobs it exposes; everything
// else (the fallback tail of `order`, cursor force, codex askForApproval, ...) stays whatever
// the user configured, so a gear touch never silently rewrites heckle.config.ts choices.
export function selectionToConfig(base: HeckleConfig, s: DeliverySelection): HeckleConfig {
  const fallbacks = base.delivery.order.filter((a) => !isDispatchAdapter(a));
  // The file-inbox floor is a product principle (always written); keep it even in a custom order.
  if (!fallbacks.includes("file-inbox")) fallbacks.unshift("file-inbox");
  const order: DeliveryAdapterName[] = s.agent === "inbox" ? fallbacks : [s.agent, ...fallbacks];
  const full = s.autonomy === "full";
  return {
    ...base,
    delivery: {
      ...base.delivery,
      order,
      claudeCode: {
        ...base.delivery.claudeCode,
        session: s.session,
        // Full = bypass every prompt; standard = edits land + the allowlist lets tests run.
        permissionMode: full ? "bypassPermissions" : "acceptEdits",
        allowedTools: full ? [] : base.delivery.claudeCode?.allowedTools ?? [],
      },
      cursor: {
        ...base.delivery.cursor,
        session: s.session,
      },
      codex: {
        ...base.delivery.codex,
        // Codex has no client-supplied id, so the gear's "persistent" cannot mint an owned
        // session. Mapping it to "continue" (resume the newest session in the dir) would error
        // on a project where codex never ran, or hijack the user's own latest conversation.
        // So accumulation stays an explicit heckle.config.ts opt-in ("continue"); the gear can
        // only force "fresh".
        session: s.session === "fresh" ? "fresh" : base.delivery.codex?.session ?? "fresh",
        sandbox: full ? "danger-full-access" : "workspace-write",
      },
    },
  };
}

// Derive the current selection from a config, for the widget to display on connect.
export function selectionFromConfig(c: HeckleConfig): DeliverySelection {
  const agent = c.delivery.order.find(isDispatchAdapter);
  if (!agent) return { agent: "inbox", session: "persistent", autonomy: "standard" };

  let session: "persistent" | "fresh" = "persistent";
  let autonomy: "standard" | "full" = "standard";
  if (agent === "claude-code") {
    session = c.delivery.claudeCode?.session === "fresh" ? "fresh" : "persistent";
    autonomy = c.delivery.claudeCode?.permissionMode === "bypassPermissions" ? "full" : "standard";
  } else if (agent === "cursor") {
    session = c.delivery.cursor?.session === "fresh" ? "fresh" : "persistent";
  } else {
    // codex: only an explicit config "continue" reads back as persistent (see selectionToConfig)
    session = c.delivery.codex?.session === "continue" ? "persistent" : "fresh";
    autonomy = c.delivery.codex?.sandbox === "danger-full-access" ? "full" : "standard";
  }
  return { agent, session, autonomy };
}
