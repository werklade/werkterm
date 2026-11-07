export type CloseAnswer = "save" | "discard" | "cancel";
export interface CloseState { remaining: number[]; phase: "pending" | "done" | "cancelled" }
export function beginClose(ids: number[]): CloseState {
  return { remaining: [...ids], phase: ids.length ? "pending" : "done" };
}
export function advanceClose(state: CloseState, answer: CloseAnswer, saved = true): CloseState {
  if (state.phase !== "pending") return state;
  if (answer === "cancel" || (answer === "save" && !saved)) return { ...state, phase: "cancelled" };
  return beginClose(state.remaining.slice(1));
}
