// 取消与中断相关的共享判断工具，供 loop 和 gateway 统一复用。

// 判断错误是否为标准的 AbortError。
export function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
}

// 判断当前是否属于因取消信号或 AbortError 触发的取消。
export function isSignalCancellation(
    signal: AbortSignal | undefined,
    error: unknown
): boolean {
    return signal?.aborted === true || isAbortError(error);
}
