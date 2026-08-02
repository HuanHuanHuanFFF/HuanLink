/**
 * Action 已经发出，但因超时、断连或异步受理而无法确认最终结果。
 * 调用方不得据此自动重试，以免产生重复消息或操作。
 */
export class OneBot11DeliveryUncertainError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : options);
    this.name = "OneBot11DeliveryUncertainError";
  }
}

/** Action 尚未可靠发出，因为 Transport 未连接或已经不可用。 */
export class OneBot11TransportUnavailableError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : options);
    this.name = "OneBot11TransportUnavailableError";
  }
}

/**
 * OneBot 远端明确拒绝 Action。
 * 只保留 `status` 和 `retcode`，避免把远端任意错误原文带入日志或调用链。
 */
export class OneBot11RemoteActionError extends Error {
  readonly status: unknown;
  readonly retcode: unknown;

  constructor(options: {
    status: unknown;
    retcode: unknown;
  }) {
    super(
      "OneBot 11 action failed: status=" +
        String(options.status) +
        " retcode=" +
        String(options.retcode),
    );
    this.name = "OneBot11RemoteActionError";
    this.status = options.status;
    this.retcode = options.retcode;
  }
}

/** 当前 OneBot 实现实例没有注入对应的可选扩展能力。 */
export class OneBot11OperationNotSupportedError extends Error {
  readonly code = "not_supported" as const;
  readonly operation: string;

  constructor(operation: string) {
    super(`OneBot 11 operation ${operation} is not supported`);
    this.name = "OneBot11OperationNotSupportedError";
    this.operation = operation;
  }
}
