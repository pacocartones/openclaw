import type { FileTarget } from "../../tool-mutation.js";

export const MAX_BEFORE_AGENT_FINALIZE_REVISIONS = 3;

export type CodeModeMutationVerificationState = {
  pendingTargets: FileTarget[];
};

export type EmbeddedRunTerminalRetryState = {
  reasoningOnlyAttempts: number;
  emptyResponseAttempts: number;
  codeModeErrorContinuationAttempts: number;
  codeModeVerificationContinuationAttempts: number;
  missingAssistantAttempts: number;
  compactionContinuationAttempts: number;
  compactionContinuationInstruction: string | null;
  beforeFinalizeRevisionAttempts: number;
  forceRestartSafeToolsForNextAttempt: boolean;
  forceReadOnlyToolsForNextAttempt: boolean;
  codeModeMutationVerification: CodeModeMutationVerificationState;
};

export function createEmbeddedRunTerminalRetryState(): EmbeddedRunTerminalRetryState {
  return {
    reasoningOnlyAttempts: 0,
    emptyResponseAttempts: 0,
    codeModeErrorContinuationAttempts: 0,
    codeModeVerificationContinuationAttempts: 0,
    missingAssistantAttempts: 0,
    compactionContinuationAttempts: 0,
    compactionContinuationInstruction: null,
    beforeFinalizeRevisionAttempts: 0,
    forceRestartSafeToolsForNextAttempt: false,
    forceReadOnlyToolsForNextAttempt: false,
    codeModeMutationVerification: { pendingTargets: [] },
  };
}

/** Read the run-latched tool restriction armed by terminal recovery. */
export function consumeForceRestartSafeToolsForNextAttempt(
  state: EmbeddedRunTerminalRetryState,
  runAlreadyForcesRestartSafeTools: boolean,
): boolean {
  return runAlreadyForcesRestartSafeTools || state.forceRestartSafeToolsForNextAttempt;
}

/** Read the run-latched read-only restriction armed by terminal verification. */
export function consumeForceReadOnlyToolsForNextAttempt(
  state: EmbeddedRunTerminalRetryState,
  runAlreadyForcesReadOnlyTools: boolean,
): boolean {
  return runAlreadyForcesReadOnlyTools || state.forceReadOnlyToolsForNextAttempt;
}
