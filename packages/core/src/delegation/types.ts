import type { ConversationJsonValue } from "../conversations/conversation-session.js";

export type AuthorizationClaim = {
  scope: string;
  evidenceMessageIds: string[];
};
export type DelegationEvidence = {
  messageId: string;
  senderId: string;
  text: string;
  entryIndex: number;
};
export type DelegationAnalysis = {
  summary: string;
  progress: string[];
  decisions: string[];
  constraints: string[];
  openQuestions: string[];
  authorization: {
    allowed: AuthorizationClaim[];
    denied: AuthorizationClaim[];
    uncertain: string[];
  };
};
export type DelegationContextPack = DelegationAnalysis & {
  type: "huanlink.delegation-context.v1";
  delegationId: string;
  sessionId: string;
  goal: string;
  revision: number;
  throughEntryIndex: number;
  userEvidence: DelegationEvidence[];
  change: "none" | "context" | "authority";
  stop: boolean;
  /** Allowed approval categories, never an OS sandbox or a grant. */
  authorityCeiling: PermissionKind[];
};
export type PermissionKind = "command" | "file-change";
export type DelegationPermissionRequest = {
  approvalId: string;
  delegationId: string;
  /** Context when the immutable native operation requested approval. */
  requestedAtRevision: number;
  kind: PermissionKind;
  operation: string;
  targets: string[];
  reason: string;
  expiresAt: string;
};
export type DelegationControl =
  | { type: "huanlink.delegation-sync.v1"; pack: DelegationContextPack }
  | {
      type: "huanlink.delegation-decision.v1";
      delegationId: string;
      approvalId: string;
      contextRevision: number;
      decision: "approve" | "deny";
    };
export type DelegationControlReceipt = {
  delegationId: string;
  revision: number;
  status: "received" | "decided";
  approvalId?: string;
};
export interface DelegationModel {
  compact(input: {
    goal: string;
    previous?: DelegationContextPack;
    facts: ConversationJsonValue[];
    authorizedSenderIds: readonly string[];
    evidenceMessageIds: readonly string[];
    maxOutputChars: number;
    signal?: AbortSignal;
  }): Promise<unknown>;
  review?(input: {
    pack: DelegationContextPack;
    request: DelegationPermissionRequest;
    facts: ConversationJsonValue[];
    signal?: AbortSignal;
  }): Promise<unknown>;
}
export type DelegationRecord = {
  sourceKey: string;
  sessionId: string;
  runId: string;
  sourceToolCallId: string;
  pack: DelegationContextPack;
  taskId?: string;
  receivedRevision: number;
  syncState: "pending" | "received" | "uncertain";
  pendingApprovalId?: string;
  askedAtRevision?: number;
  askedThroughEntryIndex?: number;
  lastResolvedApprovalId?: string;
};
export interface DelegationStore {
  get(sourceKey: string): DelegationRecord | undefined;
  list(sessionId: string): DelegationRecord[];
  put(record: DelegationRecord): void;
}
export function delegationSourceKey(
  sessionId: string,
  runId: string,
  callId: string,
): string {
  return JSON.stringify([sessionId, runId, callId]);
}
