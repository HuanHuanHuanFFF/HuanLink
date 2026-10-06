import type { ConversationSessionStore } from "../conversations/conversation-session-store.js";
import type { ConversationJsonValue } from "../conversations/conversation-session.js";
import type {
  DelegationContextPack,
  DelegationEvidence,
  DelegationModel,
  PermissionKind,
} from "./types.js";
import {
  object,
  parseDelegationAnalysis,
  parseDelegationContext,
  strings,
} from "./validation.js";

export class DelegationContextManager {
  constructor(
    private readonly options: {
      sessions: ConversationSessionStore;
      model: DelegationModel;
      authorizedSenderIds: readonly string[];
      maxInputChars?: number;
      maxContextChars?: number;
      authorityCeiling?: PermissionKind[];
    },
  ) {
    if (!options.authorizedSenderIds.length)
      throw new Error("Delegation requires explicit authorized sender IDs");
  }
  facts(sessionId: string) {
    const window = this.options.sessions.getSessionContextWindow(sessionId);
    if (!window || window.summary)
      throw new Error("Delegation requires unabridged source facts");
    const evidence = new Map<string, DelegationEvidence>();
    const facts = window.entries.map(({ entryIndex, entry }) => {
      if (entry.type === "channel_message" && entry.observed) {
        const m = entry.observed;
        if (
          !m.sender.isSelf &&
          !m.contentOmitted &&
          this.options.authorizedSenderIds.includes(m.sender.id)
        ) {
          if (evidence.has(entry.messageId))
            throw new Error("Ambiguous source evidence ID");
          evidence.set(entry.messageId, {
            messageId: entry.messageId,
            senderId: m.sender.id,
            text: m.content,
            entryIndex,
          });
        }
      }
      return { entryIndex, entry } as unknown as ConversationJsonValue;
    });
    return {
      facts,
      evidence,
      throughEntryIndex: window.entries.at(-1)?.entryIndex ?? -1,
    };
  }
  async prepare(input: {
    delegationId: string;
    sessionId: string;
    goal: string;
    previous?: DelegationContextPack;
    signal?: AbortSignal;
  }): Promise<DelegationContextPack> {
    const source = this.facts(input.sessionId);
    if (!source.evidence.size)
      throw new Error("Missing authorized user evidence");
    if (
      input.previous &&
      (input.previous.sessionId !== input.sessionId ||
        input.previous.delegationId !== input.delegationId ||
        input.previous.goal !== input.goal)
    )
      throw new Error("Delegation context binding mismatch");
    if (input.previous?.throughEntryIndex === source.throughEntryIndex)
      return structuredClone(input.previous);
    const maxInput = this.options.maxInputChars ?? 48000,
      maxOutput = this.options.maxContextChars ?? 16000;
    let previous = input.previous;
    const pending = source.facts.filter(
      (f) => Number(object(f).entryIndex) > (previous?.throughEntryIndex ?? -1),
    );
    for (let pass = 0; pending.length; pass++) {
      if (pass >= 16)
        throw new Error("Delegation compaction input budget exhausted");
      const batch: ConversationJsonValue[] = [];
      let length = JSON.stringify(previous ?? {}).length + input.goal.length;
      while (pending.length) {
        const next = pending[0]!,
          size = JSON.stringify(next).length;
        if (length + size > maxInput) {
          if (!batch.length)
            throw new Error("Delegation fact exceeds compaction budget");
          break;
        }
        batch.push(pending.shift()!);
        length += size;
      }
      input.signal?.throwIfAborted();
      const draft = object(
        await this.options.model.compact({
          goal: input.goal,
          ...(previous ? { previous: structuredClone(previous) } : {}),
          facts: batch,
          authorizedSenderIds: this.options.authorizedSenderIds,
          evidenceMessageIds: [...source.evidence.values()]
            .filter(
              (e) =>
                e.entryIndex <= Number(object(batch.at(-1)).entryIndex) &&
                (e.entryIndex > (previous?.throughEntryIndex ?? -1) ||
                  previous?.userEvidence.some(
                    (old) => old.messageId === e.messageId,
                  )),
            )
            .map((e) => e.messageId),
          maxOutputChars: maxOutput,
          ...(input.signal ? { signal: input.signal } : {}),
        }),
      );
      input.signal?.throwIfAborted();
      const analysis = parseDelegationAnalysis(draft);
      const cursor = Number(object(batch.at(-1)).entryIndex);
      const retained = new Set(strings(draft.retainedMessageIds));
      for (const claim of [
        ...analysis.authorization.allowed,
        ...analysis.authorization.denied,
      ])
        for (const id of claim.evidenceMessageIds) retained.add(id);
      const latestOwner = [...source.evidence.values()]
        .filter((e) => e.entryIndex <= cursor)
        .at(-1);
      if (latestOwner) retained.add(latestOwner.messageId);
      const evidence = [...retained].map((id) => {
        const actual = source.evidence.get(id);
        if (!actual || actual.entryIndex > cursor)
          throw new Error("Invalid authorization evidence reference");
        return actual;
      });
      const pack = parseDelegationContext({
        ...analysis,
        type: "huanlink.delegation-context.v1",
        delegationId: input.delegationId,
        sessionId: input.sessionId,
        goal: input.goal,
        revision: (previous?.revision ?? 0) + 1,
        throughEntryIndex: cursor,
        userEvidence: evidence,
        change: draft.change,
        stop: draft.stop,
        authorityCeiling: this.options.authorityCeiling ?? [
          "command",
          "file-change",
        ],
      });
      if (
        previous &&
        (JSON.stringify(pack.authorization) !==
          JSON.stringify(previous.authorization) ||
          pack.stop !== previous.stop)
      )
        pack.change = "authority";
      else if (previous && pack.change === "none") {
        // A no-sync classification cannot silently replace remotely held facts.
        pack.summary = previous.summary;
        pack.progress = previous.progress;
        pack.decisions = previous.decisions;
        pack.constraints = previous.constraints;
        pack.openQuestions = previous.openQuestions;
      }
      if (JSON.stringify(pack).length > maxOutput)
        throw new Error("Delegation context exceeds output budget");
      previous = pack;
    }
    if (
      this.facts(input.sessionId).throughEntryIndex !== source.throughEntryIndex
    )
      throw new Error(
        "Delegation source changed during compaction; refresh required",
      );
    const original = input.previous;
    if (original && previous) {
      const oldDenied = new Set(
        original.authorization.denied.map((c) => c.scope),
      );
      const allowed = new Set(
        previous.authorization.allowed.map((c) => c.scope),
      );
      if (
        previous.authorization.denied.some((c) => !oldDenied.has(c.scope)) ||
        original.authorization.allowed.some((c) => !allowed.has(c.scope))
      )
        previous.stop = true;
      if (
        JSON.stringify(previous.authorization) !==
          JSON.stringify(original.authorization) ||
        previous.stop !== original.stop
      )
        previous.change = "authority";
      else if (
        JSON.stringify([
          previous.summary,
          previous.progress,
          previous.decisions,
          previous.constraints,
          previous.openQuestions,
        ]) !==
        JSON.stringify([
          original.summary,
          original.progress,
          original.decisions,
          original.constraints,
          original.openQuestions,
        ])
      )
        previous.change = "context";
    }
    return structuredClone(previous!);
  }
}
