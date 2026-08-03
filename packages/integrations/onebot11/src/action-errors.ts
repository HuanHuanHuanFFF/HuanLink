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
 * Error message 与可枚举字段只保留安全状态码；平台原文供明确的调用方按需读取。
 */
export class OneBot11RemoteActionError extends Error {
  readonly status: unknown;
  readonly retcode: unknown;
  declare readonly remoteMessage: unknown;
  declare readonly wording: unknown;

  constructor(options: {
    status: unknown;
    retcode: unknown;
    message?: unknown;
    wording?: unknown;
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
    Object.defineProperties(this, {
      remoteMessage: { value: options.message, enumerable: false },
      wording: { value: options.wording, enumerable: false },
    });
  }
}

/** 为受控调用结果补回平台原始错误详情；普通日志不得调用此函数。 */
export function formatOneBot11RemoteActionError(
  error: OneBot11RemoteActionError,
): string {
  return (
    error.message +
    formatRemoteErrorDetail("message", error.remoteMessage) +
    formatRemoteErrorDetail("wording", error.wording)
  );
}

/** 只把 OneBot 错误详情中的标量原样加入调用方可见错误。 */
function formatRemoteErrorDetail(label: string, value: unknown): string {
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    return "";
  }
  return ` ${label}=${String(value)}`;
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
