import { Buffer } from "node:buffer";

import {
  ChannelOperationError,
  NoopRuntimeLogger,
  channelSessionIdFor,
  type ChannelAdapterV1,
  type ChannelConversationRouteV1,
  type InboundChannelMessageV1,
  type RuntimeLogFields,
  type RuntimeLogger,
  type SessionId,
} from "@huanlink/core";

import {
  copyChannelInboundAccessPolicy,
  isChannelRouteAllowed,
  type ChannelInboundAccessPolicy,
} from "./channel-access-policy.js";
import { createBestEffortRuntimeLogger } from "./best-effort-runtime-logger.js";

export type ChannelRuntimeRegistration = {
  readonly adapter: ChannelAdapterV1;
  readonly inboundPolicy: ChannelInboundAccessPolicy;
};

export type ChannelRuntimeMessage = {
  readonly sessionId: SessionId;
  readonly message: InboundChannelMessageV1;
  readonly signal: AbortSignal;
};

export type ChannelRuntimeBackgroundErrorContext = {
  readonly channelId?: string;
  readonly sessionId?: SessionId;
  readonly messageId?: string;
};

export type CreateChannelRuntimeOptions = {
  readonly channels: readonly ChannelRuntimeRegistration[];
  readonly onMessage?: (input: ChannelRuntimeMessage) => Promise<void> | void;
  readonly onBackgroundError?: (
    error: Error,
    context: ChannelRuntimeBackgroundErrorContext,
  ) => Promise<void> | void;
  readonly logger?: RuntimeLogger;
};

export interface ChannelRuntime {
  start(): Promise<void>;
  close(): Promise<void>;
  resolveAdapter(channelId: string): ChannelAdapterV1 | undefined;
  isRouteAllowed(route: ChannelConversationRouteV1): boolean;
  /** 原子替换一个 Channel 的接收名单；校验失败时继续使用旧策略。 */
  replaceAccessPolicy(
    channelId: string,
    policy: ChannelInboundAccessPolicy,
  ): void;
  /** 先校验全部候选，再一次性替换多个 Channel 的名单。 */
  replaceAccessPolicies(
    policies: ReadonlyMap<string, ChannelInboundAccessPolicy>,
  ): void;
  /** 使用 Core 的规范规则生成目标外部会话 ID。 */
  sessionIdForRoute(route: ChannelConversationRouteV1): SessionId;
  runOutbound<T>(
    route: ChannelConversationRouteV1,
    operation: () => Promise<T>,
  ): Promise<T>;
  /**
   * 在 Runtime 生命周期内执行不绑定可信 route 的 Channel 操作。
   * 此入口不做接收名单检查，也不提供审批或消息归属保护。
   */
  runOperation<T>(channelId: string, operation: () => Promise<T>): Promise<T>;
}

type RegisteredChannel = {
  readonly adapter: ChannelAdapterV1;
  inboundPolicy: ChannelInboundAccessPolicy;
  readonly orderedAdapter: ChannelAdapterV1;
};

/**
 * 组装多个 Channel Adapter 的 Server 运行时。
 *
 * Runtime 只做 Adapter 生命周期、接收名单、能力校验、事件转发和顺序控制。
 * Session 写入、消息去重、自身消息关联及 Agent 触发都属于下游编排层。
 */
export function createChannelRuntime(
  options: CreateChannelRuntimeOptions,
): ChannelRuntime {
  if (options.channels.length === 0) {
    throw new Error("ChannelRuntime requires at least one Channel Adapter");
  }

  const logger = createBestEffortRuntimeLogger(
    options.logger ?? new NoopRuntimeLogger(),
  );
  const registrations = new Map<string, RegisteredChannel>();
  const forwardTails = new Map<SessionId, Promise<void>>();
  const egressTails = new Map<SessionId, Promise<void>>();
  const activeForwards = new Set<Promise<void>>();
  const activeEgress = new Set<Promise<unknown>>();
  const activeControllers = new Set<AbortController>();
  const unsubscribers: Array<() => void> = [];
  let started = false;
  let closed = false;
  let startOperation: Promise<void> | undefined;
  let closeOperation: Promise<void> | undefined;

  const runtime: ChannelRuntime = {
    start,
    close,
    resolveAdapter(channelId) {
      return registrations.get(channelId)?.orderedAdapter;
    },
    isRouteAllowed(route) {
      const registration = registrations.get(route.channelId);
      return (
        registration !== undefined &&
        isRegisteredRouteAllowed(registration, route)
      );
    },
    replaceAccessPolicy,
    replaceAccessPolicies,
    sessionIdForRoute: channelSessionIdFor,
    runOutbound,
    runOperation,
  };

  for (const registration of options.channels) {
    const channelId = registration.adapter.descriptor.channelId;
    if (registrations.has(channelId)) {
      throw new Error(`Duplicate Channel Adapter channelId: ${channelId}`);
    }
    registrations.set(channelId, {
      adapter: registration.adapter,
      inboundPolicy: copyChannelInboundAccessPolicy(registration.inboundPolicy),
      orderedAdapter: orderedAdapter(registration.adapter, runOutbound),
    });
  }

  return runtime;

  function start(): Promise<void> {
    if (closed) {
      return Promise.reject(new Error("ChannelRuntime is closed"));
    }
    if (started) {
      return Promise.resolve();
    }
    startOperation ??= performStart().finally(() => {
      startOperation = undefined;
    });
    return startOperation;
  }

  async function performStart(): Promise<void> {
    let startingChannelId: string | undefined;
    try {
      for (const registration of registrations.values()) {
        if (closed) {
          throw new Error("ChannelRuntime closed while starting");
        }
        const channelId = registration.adapter.descriptor.channelId;
        startingChannelId = channelId;
        unsubscribers.push(
          registration.adapter.onMessage((message) =>
            receive(registration, message),
          ),
        );
        await registration.adapter.start();
        if (closed) {
          throw new Error("ChannelRuntime closed while starting");
        }
      }
      started = true;
    } catch (error) {
      const startError = normalizeError(error);
      if (!closed) {
        reportBackgroundError(startError, {
          ...(startingChannelId === undefined
            ? {}
            : { channelId: startingChannelId }),
        });
      }
      closed = true;
      try {
        await closeRegisteredAdapters();
      } catch (closeError) {
        reportBackgroundError(normalizeError(closeError), {});
      }
      unsubscribeAll();
      throw startError;
    }
  }

  function close(): Promise<void> {
    closeOperation ??= performClose();
    return closeOperation;
  }

  async function performClose(): Promise<void> {
    closed = true;
    unsubscribeAll();
    for (const controller of activeControllers) {
      controller.abort(new Error("ChannelRuntime closed"));
    }
    const startDrain = startOperation?.catch(() => undefined);
    const results = await Promise.allSettled([
      closeRegisteredAdapters(),
      Promise.allSettled([...activeForwards]),
      Promise.allSettled([...activeEgress]),
      ...(startDrain === undefined ? [] : [startDrain]),
    ]);
    started = false;
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure !== undefined) {
      throw normalizeError(failure.reason);
    }
  }

  async function closeRegisteredAdapters(): Promise<void> {
    const results = await Promise.allSettled(
      [...registrations.values()].map((registration) =>
        registration.adapter.close(),
      ),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [normalizeError(result.reason)] : [],
    );
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "ChannelRuntime close failed");
    }
  }

  function unsubscribeAll(): void {
    for (const unsubscribe of unsubscribers.splice(0)) {
      unsubscribe();
    }
  }

  async function receive(
    registration: ChannelRuntimeRegistration,
    message: InboundChannelMessageV1,
  ): Promise<void> {
    const expectedChannelId = registration.adapter.descriptor.channelId;
    const fields = messageLogFields(message);
    if (closed) {
      logger.debug("channel.runtime.message_ignored", {
        ...fields,
        reason: "runtime_closed",
      });
      return;
    }
    if (message.route.channelId !== expectedChannelId) {
      reportBackgroundError(
        new Error(
          `Channel Adapter ${expectedChannelId} emitted a message for ${message.route.channelId}`,
        ),
        {
          channelId: expectedChannelId,
          messageId: message.messageId,
        },
      );
      return;
    }
    if (
      !isRegisteredRouteAllowed(registration, message.route) ||
      !registration.adapter.descriptor.capabilities.inboundContentFormats.includes(
        message.contentFormat,
      )
    ) {
      logger.info("channel.runtime.message_rejected", {
        ...fields,
        reason: "access_policy",
      });
      return;
    }

    const sessionId = channelSessionIdFor(message.route);
    const acceptedFields = { ...fields, sessionId };
    logger.info("channel.runtime.message_accepted", acceptedFields);
    if (options.onMessage === undefined) {
      return;
    }
    scheduleForward(sessionId, message, acceptedFields);
  }

  function scheduleForward(
    sessionId: SessionId,
    message: InboundChannelMessageV1,
    fields: RuntimeLogFields,
  ): void {
    const controller = new AbortController();
    const previous = forwardTails.get(sessionId) ?? Promise.resolve();
    const handler = previous
      .catch(() => undefined)
      .then(() => {
        if (closed || controller.signal.aborted) {
          return;
        }
        return options.onMessage?.({
          sessionId,
          message,
          signal: controller.signal,
        });
      });
    const operation = waitWithSignal(handler, controller.signal).then(
      () => undefined,
    );
    const tail = operation.catch(() => undefined);
    forwardTails.set(sessionId, tail);
    activeForwards.add(operation);
    activeControllers.add(controller);
    void operation.then(
      () => finishForward(),
      (error) => {
        if (!(closed && controller.signal.aborted)) {
          reportBackgroundError(normalizeError(error), {
            channelId: message.route.channelId,
            sessionId,
            messageId: message.messageId,
          });
        }
        finishForward();
      },
    );

    function finishForward(): void {
      activeForwards.delete(operation);
      activeControllers.delete(controller);
      if (forwardTails.get(sessionId) === tail) {
        forwardTails.delete(sessionId);
      }
      logger.debug("channel.runtime.message_dispatched", fields);
    }
  }

  function replaceAccessPolicy(
    channelId: string,
    policy: ChannelInboundAccessPolicy,
  ): void {
    replaceAccessPolicies(new Map([[channelId, policy]]));
  }

  function replaceAccessPolicies(
    policies: ReadonlyMap<string, ChannelInboundAccessPolicy>,
  ): void {
    const replacements: Array<{
      channelId: string;
      registration: RegisteredChannel;
      policy: ChannelInboundAccessPolicy;
    }> = [];

    try {
      for (const [channelId, policy] of policies) {
        const registration = registrations.get(channelId);
        if (registration === undefined) {
          throw new Error(`No Channel Adapter is registered for ${channelId}`);
        }
        replacements.push({
          channelId,
          registration,
          policy: copyChannelInboundAccessPolicy(policy),
        });
      }
    } catch (error) {
      logger.error("channel.runtime.access_policy_rejected", {
        errorType: normalizeError(error).name,
      });
      throw error;
    }

    for (const replacement of replacements) {
      replacement.registration.inboundPolicy = replacement.policy;
    }
    for (const replacement of replacements) {
      logger.info("channel.runtime.access_policy_replaced", {
        channelId: replacement.channelId,
        groupMode: replacement.policy.groups.mode,
        groupIdCount: replacement.policy.groups.ids.length,
        directMode: replacement.policy.directs.mode,
        directIdCount: replacement.policy.directs.ids.length,
      });
    }
  }

  function runOutbound<T>(
    route: ChannelConversationRouteV1,
    operation: () => Promise<T>,
  ): Promise<T> {
    const registration = registrations.get(route.channelId);
    if (registration === undefined) {
      return Promise.reject(
        new ChannelOperationError(
          "invalid_target",
          `No Channel Adapter is registered for ${route.channelId}`,
        ),
      );
    }
    if (closed) {
      return Promise.reject(
        new ChannelOperationError(
          "temporarily_unavailable",
          "ChannelRuntime is closed",
        ),
      );
    }
    if (!started) {
      return Promise.reject(
        new ChannelOperationError(
          "temporarily_unavailable",
          "ChannelRuntime is not started",
        ),
      );
    }
    if (!isRegisteredRouteAllowed(registration, route)) {
      return Promise.reject(
        new ChannelOperationError(
          "invalid_target",
          "Channel target is outside the allowed scope",
        ),
      );
    }

    const sessionId = channelSessionIdFor(route);
    const previous = egressTails.get(sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => {
        if (closed) {
          throw new ChannelOperationError(
            "temporarily_unavailable",
            "ChannelRuntime is closed",
          );
        }
        if (!isRegisteredRouteAllowed(registration, route)) {
          throw new ChannelOperationError(
            "invalid_target",
            "Channel target is outside the allowed scope",
          );
        }
        return operation();
      });
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    egressTails.set(sessionId, tail);
    trackEgress(current);
    void tail.then(() => {
      if (egressTails.get(sessionId) === tail) {
        egressTails.delete(sessionId);
      }
    });
    return current;
  }

  function runOperation<T>(
    channelId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!registrations.has(channelId)) {
      return Promise.reject(
        new Error(`No Channel Adapter is registered for ${channelId}`),
      );
    }
    if (closed) {
      return Promise.reject(new Error("ChannelRuntime is closed"));
    }
    if (!started) {
      return Promise.reject(new Error("ChannelRuntime is not started"));
    }

    const current = Promise.resolve().then(() => {
      if (closed) {
        throw new Error("ChannelRuntime is closed");
      }
      return operation();
    });
    trackEgress(current);
    return current;
  }

  function trackEgress(operation: Promise<unknown>): void {
    activeEgress.add(operation);
    void operation.then(
      () => activeEgress.delete(operation),
      () => activeEgress.delete(operation),
    );
  }

  function reportBackgroundError(
    error: Error,
    context: ChannelRuntimeBackgroundErrorContext,
  ): void {
    logger.error("channel.runtime.background_failed", {
      ...context,
      errorType: error.name,
    });
    try {
      void Promise.resolve(options.onBackgroundError?.(error, context)).catch(
        () => undefined,
      );
    } catch {
      // Error observers must not break Channel message processing.
    }
  }
}

function orderedAdapter(
  adapter: ChannelAdapterV1,
  runOutbound: ChannelRuntime["runOutbound"],
): ChannelAdapterV1 {
  return {
    descriptor: adapter.descriptor,
    start: () => adapter.start(),
    close: () => adapter.close(),
    onMessage: (listener) => adapter.onMessage(listener),
    send: (command) =>
      runOutbound(command.route, () => {
        const capabilities = adapter.descriptor.capabilities;
        const unsupportedPart = command.parts.find(
          (part) => !capabilities.outboundPartTypes.includes(part.type),
        );
        if (unsupportedPart !== undefined) {
          throw new ChannelOperationError(
            "not_supported",
            `Channel Adapter does not support outbound part ${unsupportedPart.type}`,
          );
        }
        if (command.replyToMessageId !== undefined && !capabilities.reply) {
          throw new ChannelOperationError(
            "not_supported",
            "Channel Adapter does not support replies",
          );
        }
        return adapter.send(command);
      }),
    retract: (command) =>
      runOutbound(command.route, () => {
        if (!adapter.descriptor.capabilities.retract) {
          throw new ChannelOperationError(
            "not_supported",
            "Channel Adapter does not support message retraction",
          );
        }
        return adapter.retract(command);
      }),
  };
}

function isRegisteredRouteAllowed(
  registration: ChannelRuntimeRegistration,
  route: ChannelConversationRouteV1,
): boolean {
  const capabilities = registration.adapter.descriptor.capabilities;
  return (
    isChannelRouteAllowed(registration.inboundPolicy, route) &&
    capabilities.conversationKinds.includes(route.conversationKind) &&
    (route.threadId === undefined || capabilities.threads)
  );
}

function messageLogFields(message: InboundChannelMessageV1): RuntimeLogFields {
  return {
    channelId: message.route.channelId,
    conversationKind: message.route.conversationKind,
    conversationId: message.route.conversationId,
    messageId: message.messageId,
    senderId: message.sender.id,
    isSelf: message.sender.isSelf,
    contentBytes:
      message.contentOmitted?.originalSizeBytes ??
      Buffer.byteLength(message.content, "utf8"),
    ...(message.trigger === undefined ? {} : { trigger: message.trigger.kind }),
  };
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function waitWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("ChannelRuntime operation aborted");
}
