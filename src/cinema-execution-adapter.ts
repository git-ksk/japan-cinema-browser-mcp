import {
  defineExecutionAdapter,
  type RegisteredExecutionAdapter,
  type ResumeDecision
} from "mcp-execution-handoff/core";
import type {
  CinemaBrowserRuntime,
  CinemaIntervention
} from "./browser/runtime.js";

export type CinemaExecutionAdapter = RegisteredExecutionAdapter<
  CinemaIntervention,
  ResumeDecision<never>
>;

export function createCinemaExecutionAdapter(runtime: CinemaBrowserRuntime): CinemaExecutionAdapter {
  return defineExecutionAdapter("browser.cinema", runtime);
}
