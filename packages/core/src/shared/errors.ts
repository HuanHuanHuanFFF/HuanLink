// 把未知异常值规整成可读的错误消息字符串。
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// 把未知异常收窄为可能带 code 字段的 Node 风格错误。
export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}

// 判断是否为文件或目录不存在（ENOENT）错误。
export function isNotFoundError(error: unknown): boolean {
    return isNodeError(error) && error.code === "ENOENT";
}
