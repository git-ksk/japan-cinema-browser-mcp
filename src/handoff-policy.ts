import type { HandoffResumeStrategy, ResumePolicy } from "mcp-execution-handoff/core";

export type CinemaHandoffOperationClass =
  | "read"
  | "navigation"
  | "semantic_mutation"
  | "transaction";

export interface CinemaHandoffPolicy {
  resumePolicy: ResumePolicy;
  resumeStrategy: HandoffResumeStrategy;
}

export const CINEMA_HANDOFF_POLICY: Readonly<Record<CinemaHandoffOperationClass, CinemaHandoffPolicy>> = {
  read: {
    resumePolicy: "replay_safe",
    resumeStrategy: "retry_original"
  },
  navigation: {
    resumePolicy: "revalidate",
    resumeStrategy: "require_fresh_semantic_action"
  },
  semantic_mutation: {
    resumePolicy: "never_replay",
    resumeStrategy: "require_fresh_semantic_action"
  },
  transaction: {
    resumePolicy: "never_replay",
    resumeStrategy: "require_fresh_semantic_action"
  }
};
