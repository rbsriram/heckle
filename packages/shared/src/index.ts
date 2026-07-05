// Public surface of @heckle/shared.
//
// Only types are exported here so this entry stays free of any third-party runtime
// dependency (it can be imported by any package before `npm install`). The zod schema
// lives at "@heckle/shared/feedback" and is pulled in starting at M2 (Drafting).
export type * from "./types.ts";
