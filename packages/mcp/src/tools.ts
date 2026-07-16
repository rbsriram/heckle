export const HECKLE_TOOLS = [
  {
    name: "heckle_list_open",
    description: "List open Heckle QA issues, optionally filtered by route or severity.",
    inputSchema: {
      type: "object",
      properties: { route: { type: "string" }, severity: { type: "string", enum: ["blocker", "bug", "polish"] } },
      additionalProperties: false,
    },
  },
  {
    name: "heckle_get_task",
    description: "Get one QA task with its utterance, captured evidence, receipt, and repro reference.",
    inputSchema: {
      type: "object",
      properties: { issue_id: { type: "string" } },
      required: ["issue_id"],
      additionalProperties: false,
    },
  },
  {
    name: "heckle_search_memory",
    description: "Search local issue and fix history by free text.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "heckle_check_regressions",
    description: "Select regressions intersecting changed files and optionally replay them.",
    inputSchema: {
      type: "object",
      properties: {
        changed_files: { type: "array", items: { type: "string" } },
        run: { type: "boolean", default: false },
        origin: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "heckle_run_repro",
    description: "Replay one repro and return assertion-level pass or fail evidence.",
    inputSchema: {
      type: "object",
      properties: { repro_id: { type: "string" }, origin: { type: "string" } },
      required: ["repro_id"],
      additionalProperties: false,
    },
  },
  {
    name: "heckle_mark_ready",
    description: "Mark an issue ready and trigger its two-run replay verification.",
    inputSchema: {
      type: "object",
      properties: { issue_id: { type: "string" }, origin: { type: "string" } },
      required: ["issue_id"],
      additionalProperties: false,
    },
  },
  {
    name: "heckle_get_fix_history",
    description: "Get past fixes and outcomes for an element identity or route.",
    inputSchema: {
      type: "object",
      properties: { element: { type: "string" }, route: { type: "string" } },
      additionalProperties: false,
      anyOf: [{ required: ["element"] }, { required: ["route"] }],
    },
  },
] as const;
