import { classify, type Classification } from "./classify.ts";

export type RouteLane = "instant" | "agent" | "question";

export interface RouteDecision {
  lane: RouteLane;
  stage: "rules" | "model" | "fallback";
  reason: string;
  edit?: Classification;
}

const QUESTION = /^(?:what|why|how|where|when|which|who|is|are|can|could|should|does|do|did|will|would)\b|\?$/i;
const CHANGE = /\b(?:change|make|set|update|replace|rename|call|hide|show|move|fix|add|remove)\b/i;

export async function routeRequest(
  transcript: string,
  classifyAmbiguous?: (transcript: string) => Promise<RouteLane>,
): Promise<RouteDecision> {
  const edit = classify(transcript);
  if (edit.lane === "copy" || edit.lane === "style") {
    return { lane: "instant", stage: "rules", reason: edit.reason, edit };
  }
  if (QUESTION.test(transcript.trim()) && !CHANGE.test(transcript)) {
    return { lane: "question", stage: "rules", reason: "question-form" };
  }
  if (classifyAmbiguous) {
    try {
      return { lane: await classifyAmbiguous(transcript), stage: "model", reason: "ambiguous-model-label" };
    } catch {}
  }
  return { lane: "agent", stage: "fallback", reason: edit.reason, edit };
}
