import { randomUUID } from "node:crypto";
import type { AgentCallService } from "../agent-call/agent-call-service.js";
import type {
  AgentCallInvoker,
  AgentCallInvocationResult,
  AgentCallRequest,
} from "../agent-call/types.js";
import type { AsyncToolTaskService } from "../async-tool-task/async-tool-task-service.js";
import {
  isAsyncToolTaskTerminalState,
  type AsyncToolTask,
} from "../async-tool-task/types.js";
import type { ConversationSessionStore } from "../conversations/conversation-session-store.js";
import type { RuntimeLogger } from "../logging/types.js";
import { NoopRuntimeLogger } from "../logging/noop-runtime-logger.js";
import { DelegationContextManager } from "./context-manager.js";
import {
  delegationSourceKey,
  type DelegationModel,
  type DelegationRecord,
  type DelegationStore,
  type PermissionKind,
} from "./types.js";
import { object, parsePermissionRequest, strings } from "./validation.js";

export type DelegationCoordinatorOptions = {
  sessions: ConversationSessionStore;
  tasks: AsyncToolTaskService;
  agentCalls: AgentCallService;
  store: DelegationStore;
  model: DelegationModel;
  authorizedSenderIds: readonly string[];
  authorityCeiling?: PermissionKind[];
  maxInputChars?: number;
  maxContextChars?: number;
  logger?: RuntimeLogger;
};
export class DelegationCoordinator implements AgentCallInvoker {
  private readonly contexts: DelegationContextManager;
  private readonly logger: RuntimeLogger;
  private readonly submissions = new Map<
    string,
    Promise<AgentCallInvocationResult>
  >();
  constructor(private readonly options: DelegationCoordinatorOptions) {
    this.contexts = new DelegationContextManager(options);
    this.logger = options.logger ?? new NoopRuntimeLogger();
  }
  invoke(request: AgentCallRequest): Promise<AgentCallInvocationResult> {
    const key = delegationSourceKey(
      request.sessionId,
      request.runId,
      request.sourceToolCallId,
    );
    const running = this.submissions.get(key);
    if (running) return running;
    const operation = this.submit(request, key).finally(() =>
      this.submissions.delete(key),
    );
    this.submissions.set(key, operation);
    return operation;
  }
  private async submit(
    request: AgentCallRequest,
    key: string,
  ): Promise<AgentCallInvocationResult> {
    if (request.executionMode !== "async")
      throw new Error(
        "Delegation experiment requires async tasks for context and permissions",
      );
    let row = this.options.store.get(key);
    if (!row) {
      const pack = await this.contexts.prepare({
        delegationId: randomUUID(),
        sessionId: request.sessionId,
        goal: request.input,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (pack.stop)
        throw new Error(
          "Delegation context requires stopping rather than dispatch",
        );
      row = {
        sourceKey: key,
        sessionId: request.sessionId,
        runId: request.runId,
        sourceToolCallId: request.sourceToolCallId,
        pack,
        receivedRevision: 0,
        syncState: "pending",
      };
      this.options.store.put(row);
    }
    if (row.pack.goal !== request.input)
      throw new Error("Delegation source reused with a different task");
    const result = await this.options.agentCalls.invoke({
      ...request,
      contextId: row.pack.delegationId,
      inputData: { ...request.inputData, delegation: row.pack },
    });
    if (result.status === "accepted") {
      row = {
        ...row,
        taskId: result.taskId,
        receivedRevision: result.state === "unknown" ? 0 : row.pack.revision,
        syncState: result.state === "unknown" ? "uncertain" : "received",
      };
      this.options.store.put(row);
      this.log("delegation.dispatched", row);
    }
    return result;
  }
  async synchronizeSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const candidate of this.options.store.list(sessionId)) {
      if (!candidate.taskId) continue;
      const task = this.options.tasks.get(sessionId, candidate.taskId);
      if (
        !task ||
        isAsyncToolTaskTerminalState(task.state) ||
        task.state === "unknown"
      )
        continue;
      await this.refresh(candidate, signal);
      const latest = this.options.tasks.get(sessionId, candidate.taskId);
      if (
        latest?.state === "input-required" &&
        latest.payload.permissionRequest
      )
        await this.resolvePermission(latest, signal);
    }
  }
  private async refresh(
    row: DelegationRecord,
    signal?: AbortSignal,
  ): Promise<DelegationRecord> {
    if (row.syncState === "uncertain")
      throw new Error(
        "Delegation synchronization outcome requires reconciliation",
      );
    const previous = row.pack;
    const pack = await this.contexts.prepare({
      delegationId: previous.delegationId,
      sessionId: row.sessionId,
      goal: previous.goal,
      previous,
      ...(signal ? { signal } : {}),
    });
    if (pack.revision === previous.revision) return row;
    row = {
      ...row,
      pack,
      syncState: pack.change === "none" ? "received" : "pending",
    };
    this.options.store.put(row);
    if (pack.change === "none") {
      this.log("delegation.sync.skipped", row);
      return row;
    }
    if (!row.taskId)
      throw new Error("Delegation is not bound to an accepted task");
    try {
      const receipt = await this.options.agentCalls.controlTask(
        row.sessionId,
        row.taskId,
        { type: "huanlink.delegation-sync.v1", pack },
        signal,
      );
      if (
        receipt.revision !== pack.revision ||
        receipt.delegationId !== pack.delegationId
      )
        throw new Error("Context receipt mismatch");
      row = {
        ...row,
        receivedRevision: receipt.revision,
        syncState: "received",
      };
      this.options.store.put(row);
      this.log(
        pack.stop ? "delegation.stopped" : "delegation.sync.received",
        row,
      );
      return row;
    } catch (error) {
      this.options.store.put({ ...row, syncState: "uncertain" });
      this.log("delegation.sync.uncertain", row);
      throw error;
    }
  }
  async resolvePermission(
    task: AsyncToolTask,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (task.state !== "input-required" || !task.payload.permissionRequest)
      return false;
    let row = this.options.store.get(
      delegationSourceKey(
        task.sessionId,
        task.sourceRunId,
        task.sourceToolCallId,
      ),
    );
    if (!row) return false;
    if (!row.taskId) {
      row = {
        ...row,
        taskId: task.taskId,
        receivedRevision: row.pack.revision,
        syncState: "received",
      };
      this.options.store.put(row);
    }
    row = await this.refresh(row, signal);
    const latest = this.options.tasks.get(task.sessionId, task.taskId);
    if (!latest || isAsyncToolTaskTerminalState(latest.state)) return true;
    if (!latest.payload.permissionRequest) return false;
    const request = parsePermissionRequest(latest.payload.permissionRequest);
    if (
      request.delegationId !== row.pack.delegationId ||
      request.requestedAtRevision > row.receivedRevision ||
      row.syncState !== "received"
    )
      throw new Error("Permission context binding mismatch");
    let decision: "approve" | "deny" | "ask-user" = "ask-user";
    if (
      !row.pack.authorityCeiling.includes(request.kind) ||
      Date.parse(request.expiresAt) <= Date.now()
    )
      decision = "deny";
    else if (this.options.model.review) {
      const source = this.contexts.facts(row.sessionId);
      try {
        const recentSelf = new Set(
          source.facts
            .filter((fact) => {
              const entry = object(object(fact).entry);
              return (
                entry.type === "channel_message" &&
                !!entry.observed &&
                object(object(entry.observed).sender).isSelf === true
              );
            })
            .slice(-8)
            .map((fact) => String(object(object(fact).entry).messageId)),
        );
        const evidenceIds = new Set(
          row.pack.userEvidence.map((e) => e.messageId),
        );
        const reviewFacts = source.facts.filter((fact) => {
          const entry = object(object(fact).entry);
          if (entry.type !== "channel_message") return false;
          if (evidenceIds.has(String(entry.messageId))) return true;
          const observed = entry.observed ? object(entry.observed) : undefined;
          return (
            !!observed &&
            object(observed.sender).isSelf === true &&
            (String(observed.content).includes(request.approvalId) ||
              recentSelf.has(String(entry.messageId)))
          );
        });
        if (
          JSON.stringify(reviewFacts).length >
          (this.options.maxInputChars ?? 48000)
        )
          throw new Error("Permission evidence exceeds review budget");
        const review = object(
          await this.options.model.review({
            pack: row.pack,
            request,
            facts: reviewFacts,
            ...(signal ? { signal } : {}),
          }),
        );
        signal?.throwIfAborted();
        const ids = strings(review.evidenceMessageIds);
        const allowedIds = new Set(
          row.pack.authorization.allowed.flatMap((c) => c.evidenceMessageIds),
        );
        const current = this.contexts.facts(row.sessionId);
        if (current.throughEntryIndex !== source.throughEntryIndex) {
          this.log("delegation.review.stale", row);
          return false;
        }
        if (review.decision === "deny") decision = "deny";
        else if (
          review.decision === "approve" &&
          ids.length > 0 &&
          ids.every((id) => source.evidence.has(id) && allowedIds.has(id)) &&
          this.confirmationIsBound(row, request.approvalId, ids, source)
        )
          decision = "approve";
      } catch (error) {
        if (signal?.aborted) throw error;
        this.log("delegation.review.unavailable", row);
      }
    }
    if (decision === "ask-user") {
      this.options.store.put({
        ...row,
        pendingApprovalId: request.approvalId,
        askedAtRevision:
          row.pendingApprovalId === request.approvalId
            ? row.askedAtRevision
            : row.pack.revision,
        askedThroughEntryIndex:
          row.pendingApprovalId === request.approvalId
            ? row.askedThroughEntryIndex
            : row.pack.throughEntryIndex,
      });
      this.log("delegation.permission.user_required", row);
      return false;
    }
    const current = this.options.tasks.get(task.sessionId, task.taskId);
    if (
      !current?.payload.permissionRequest ||
      parsePermissionRequest(current.payload.permissionRequest).approvalId !==
        request.approvalId
    )
      return false;
    await this.options.agentCalls.controlTask(
      row.sessionId,
      task.taskId,
      {
        type: "huanlink.delegation-decision.v1",
        delegationId: row.pack.delegationId,
        approvalId: request.approvalId,
        contextRevision: row.receivedRevision,
        decision,
      },
      signal,
    );
    this.options.store.put({
      ...row,
      pendingApprovalId: undefined,
      askedAtRevision: undefined,
      askedThroughEntryIndex: undefined,
      lastResolvedApprovalId: request.approvalId,
    });
    this.log(
      decision === "approve"
        ? "delegation.permission.approved"
        : "delegation.permission.denied",
      row,
    );
    return true;
  }
  private confirmationIsBound(
    row: DelegationRecord,
    approvalId: string,
    ids: string[],
    source: ReturnType<DelegationContextManager["facts"]>,
  ): boolean {
    if (row.pendingApprovalId !== approvalId) return true;
    if (row.askedThroughEntryIndex === undefined) return false;
    const fresh = ids.flatMap((id) => {
      const e = source.evidence.get(id);
      return e && e.entryIndex > row.askedThroughEntryIndex! ? [e] : [];
    });
    if (!fresh.length) return false;
    const rows = this.options.store.list(row.sessionId);
    const pendingCount = rows.filter(
      (r) =>
        r.taskId &&
        this.options.tasks.get(row.sessionId, r.taskId)?.payload
          .permissionRequest,
    ).length;
    const messages = source.facts.flatMap((f) => {
      const entry = object(object(f).entry);
      return entry.type === "channel_message" && entry.observed
        ? [
            {
              messageId: String(entry.messageId),
              entryIndex: Number(object(f).entryIndex),
              observed: object(entry.observed),
            },
          ]
        : [];
    });
    for (const evidence of fresh) {
      const observed = messages.find(
        (m) => m.messageId === evidence.messageId,
      )?.observed;
      const referenced = observed?.replyToMessageId
        ? messages.find(
            (m) =>
              m.messageId === observed.replyToMessageId &&
              object(m.observed.sender).isSelf === true,
          )
        : undefined;
      const findTargets = (text: string) =>
        rows.filter((r) =>
          [r.taskId, r.pendingApprovalId, r.lastResolvedApprovalId].some(
            (id) => id && text.includes(id),
          ),
        );
      const directTargets = findTargets(evidence.text);
      const replyTargets = referenced
        ? findTargets(String(referenced.observed.content))
        : [];
      if (
        directTargets.length &&
        replyTargets.length &&
        (directTargets.length !== 1 ||
          replyTargets.length !== 1 ||
          directTargets[0]!.sourceKey !== replyTargets[0]!.sourceKey)
      )
        continue;
      const targets = directTargets.length ? directTargets : replyTargets;
      if (targets.length) {
        if (targets.length === 1 && targets[0]!.sourceKey === row.sourceKey)
          return true;
        continue;
      }
      if (pendingCount !== 1) continue;
      if (
        /^(是|好|好的|可以|同意|允许|继续|yes|ok|okay)[。.!！\s]*$/i.test(
          evidence.text.trim(),
        )
      ) {
        const lastSelf = messages
          .filter(
            (m) =>
              m.entryIndex < evidence.entryIndex &&
              object(m.observed.sender).isSelf === true,
          )
          .at(-1);
        if (
          !lastSelf ||
          !String(lastSelf.observed.content).includes(approvalId)
        )
          continue;
      }
      return true;
    }
    return false;
  }
  private log(event: string, row: DelegationRecord) {
    try {
      this.logger.info(event, {
        sessionId: row.sessionId,
        taskId: row.taskId ?? "",
        revision: row.pack.revision,
        receivedRevision: row.receivedRevision,
        contextChars: JSON.stringify(row.pack).length,
      });
    } catch {}
  }
}
