import type {
  AuthorizationClaim,
  DelegationAnalysis,
  DelegationContextPack,
  DelegationPermissionRequest,
  PermissionKind,
} from "./types.js";
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid delegation object");
  return value as Record<string, unknown>;
}
export function textValue(value: unknown, max = 12000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("Invalid delegation text");
  return value;
}
export function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 128)
    throw new Error("Invalid delegation list");
  return value.map((v) => textValue(v));
}
export function integer(value: unknown, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
    throw new Error("Invalid delegation revision");
  return value;
}
export function permissionKinds(value: unknown): PermissionKind[] {
  const values = strings(value);
  if (
    values.some((v) => v !== "command" && v !== "file-change") ||
    new Set(values).size !== values.length
  )
    throw new Error("Invalid authority ceiling");
  return values as PermissionKind[];
}
function claims(value: unknown): AuthorizationClaim[] {
  if (!Array.isArray(value) || value.length > 64)
    throw new Error("Invalid authorization claims");
  return value.map((raw) => {
    const v = object(raw);
    const evidenceMessageIds = strings(v.evidenceMessageIds);
    if (!evidenceMessageIds.length)
      throw new Error("Missing authorization evidence");
    return { scope: textValue(v.scope), evidenceMessageIds };
  });
}
export function parseDelegationAnalysis(value: unknown): DelegationAnalysis {
  const v = object(value),
    a = object(v.authorization);
  return {
    summary: textValue(v.summary),
    progress: strings(v.progress),
    decisions: strings(v.decisions),
    constraints: strings(v.constraints),
    openQuestions: strings(v.openQuestions),
    authorization: {
      allowed: claims(a.allowed),
      denied: claims(a.denied),
      uncertain: strings(a.uncertain),
    },
  };
}
export function parseDelegationContext(value: unknown): DelegationContextPack {
  const v = object(value);
  if (
    v.type !== "huanlink.delegation-context.v1" ||
    !["none", "context", "authority"].includes(String(v.change)) ||
    typeof v.stop !== "boolean"
  )
    throw new Error("Invalid delegation context version/change");
  if (!Array.isArray(v.userEvidence) || v.userEvidence.length > 128)
    throw new Error("Invalid user evidence");
  const userEvidence = v.userEvidence.map((raw) => {
    const e = object(raw);
    return {
      messageId: textValue(e.messageId, 1024),
      senderId: textValue(e.senderId, 1024),
      text: textValue(e.text),
      entryIndex: integer(e.entryIndex),
    };
  });
  if (
    new Set(userEvidence.map((e) => e.messageId)).size !== userEvidence.length
  )
    throw new Error("Duplicate user evidence");
  const pack: DelegationContextPack = {
    ...parseDelegationAnalysis(v),
    type: "huanlink.delegation-context.v1",
    delegationId: textValue(v.delegationId, 1024),
    sessionId: textValue(v.sessionId, 1024),
    goal: textValue(v.goal),
    revision: integer(v.revision, 1),
    throughEntryIndex: integer(v.throughEntryIndex),
    userEvidence,
    change: v.change as DelegationContextPack["change"],
    stop: v.stop,
    authorityCeiling: permissionKinds(v.authorityCeiling),
  };
  const ids = new Set(userEvidence.map((e) => e.messageId));
  for (const claim of [
    ...pack.authorization.allowed,
    ...pack.authorization.denied,
  ])
    if (claim.evidenceMessageIds.some((id) => !ids.has(id)))
      throw new Error("Unbound authorization evidence");
  if (userEvidence.some((e) => e.entryIndex > pack.throughEntryIndex))
    throw new Error("Future user evidence");
  if (JSON.stringify(pack).length > 64000)
    throw new Error("Delegation context exceeds wire budget");
  return pack;
}
export function parsePermissionRequest(
  value: unknown,
): DelegationPermissionRequest {
  const v = object(value);
  if (v.kind !== "command" && v.kind !== "file-change")
    throw new Error("Unsupported permission kind");
  const expiresAt = textValue(v.expiresAt, 80);
  if (!Number.isFinite(Date.parse(expiresAt)))
    throw new Error("Invalid permission expiry");
  return {
    approvalId: textValue(v.approvalId, 1024),
    delegationId: textValue(v.delegationId, 1024),
    requestedAtRevision: integer(v.requestedAtRevision, 1),
    kind: v.kind,
    operation: textValue(v.operation, 20000),
    targets: strings(v.targets),
    reason: typeof v.reason === "string" ? v.reason.slice(0, 4000) : "",
    expiresAt,
  };
}
