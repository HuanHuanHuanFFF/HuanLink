import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";

import type { OneBot11Action, OneBot11JsonObject } from "./codec.js";
import type { OneBot11ForwardNode } from "./operation-contracts.js";

/** 只接受普通对象及显式允许的字段，防止附加字段越过上层参数白名单。 */
export function assertExactObject(
  input: unknown,
  allowedKeys: readonly string[],
  label: string,
): OneBot11JsonObject {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError(`${label} must be an object`);
  }

  const object = input as OneBot11JsonObject;
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${label} contains unsupported field ${String(key)}`);
    }
  }
  return object;
}

/** 将正整数 ID 转为 OneBot 参数；超出安全整数范围时保留字符串。 */
export function parsePositiveIdParameter(
  input: unknown,
  label: string,
): number | string {
  if (typeof input !== "string" || !/^[1-9]\d*$/u.test(input)) {
    throw new TypeError(`${label} must be a positive integer string`);
  }
  const parsed = Number(input);
  return Number.isSafeInteger(parsed) ? parsed : input;
}

/** 将允许负数的消息 ID 转为 OneBot 参数，并避免大整数精度丢失。 */
export function parseMessageIdParameter(
  input: unknown,
  label: string,
): number | string {
  if (typeof input !== "string" || !/^-?\d+$/u.test(input)) {
    throw new TypeError(`${label} must be an integer string`);
  }
  const parsed = Number(input);
  return Number.isSafeInteger(parsed) ? parsed : input;
}

/** 校验必须存在的字符串；判断空值时不修改原始内容。 */
export function requireNonBlankString(input: unknown, label: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return input;
}

/** 校验消息内容非空但保留纯空白文本，不对正文做 trim。 */
export function requireNonEmptyString(input: unknown, label: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return input;
}

/** 校验允许为空字符串的文本字段。 */
export function requireString(input: unknown, label: string): string {
  if (typeof input !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return input;
}

/** 校验可选字符串；省略与显式空字符串保持不同语义。 */
export function optionalString(
  input: unknown,
  label: string,
): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  return requireString(input, label);
}

/** 校验必填布尔值。 */
export function requireBoolean(input: unknown, label: string): boolean {
  if (typeof input !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
  return input;
}

/** 校验可选布尔值，并在省略时使用显式默认值。 */
export function optionalBoolean(
  input: unknown,
  defaultValue: boolean,
  label: string,
): boolean {
  return input === undefined ? defaultValue : requireBoolean(input, label);
}

/** 校验非负安全整数；OneBot 时长单位统一为秒。 */
export function requireNonNegativeSafeInteger(
  input: unknown,
  label: string,
): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return input as number;
}

/** 专属头衔时长允许 `-1` 表示永久，其余值必须为非负安全整数。 */
export function optionalSpecialTitleDuration(input: unknown): number {
  if (input === undefined) {
    return -1;
  }
  if (input === -1) {
    return -1;
  }
  return requireNonNegativeSafeInteger(
    input,
    "OneBot 11 special title durationSeconds",
  );
}

/** 好友赞次数受 OneBot 11 单次公开接口范围限制为 1 到 10。 */
export function optionalLikeTimes(input: unknown): number {
  if (input === undefined) {
    return 1;
  }
  const value = typeof input === "number" ? input : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10) {
    throw new TypeError("OneBot 11 like times must be an integer from 1 to 10");
  }
  return value;
}

/** 校验字符串枚举并保留其精确类型。 */
export function requireEnum<T extends string>(
  input: unknown,
  allowedValues: readonly T[],
  label: string,
): T {
  if (typeof input !== "string" || !allowedValues.includes(input as T)) {
    throw new TypeError(`${label} must be one of ${allowedValues.join(", ")}`);
  }
  return input as T;
}

/** 校验并保留引用节点与自定义节点的原始顺序。 */
export function parseForwardNodes(
  input: unknown,
): readonly OneBot11ForwardNode[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError("OneBot 11 forward nodes must be a non-empty array");
  }

  return input.map((node, index) => {
    const label = `OneBot 11 forward node ${index}`;
    const object = assertExactObject(
      node,
      nodeKind(node) === "reference"
        ? ["kind", "messageId"]
        : ["kind", "userId", "displayName", "content"],
      label,
    );
    const kind = requireEnum(
      object.kind,
      ["reference", "custom"] as const,
      `${label} kind`,
    );

    if (kind === "reference") {
      parseMessageIdParameter(object.messageId, `${label} message ID`);
      return {
        kind,
        messageId: object.messageId as string,
      };
    }

    parsePositiveIdParameter(object.userId, `${label} user ID`);
    return {
      kind,
      userId: object.userId as string,
      displayName: requireNonBlankString(
        object.displayName,
        `${label} display name`,
      ),
      content: requireNonEmptyString(object.content, `${label} content`),
    };
  });
}

function nodeKind(input: unknown): unknown {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as OneBot11JsonObject).kind
    : undefined;
}

/** 确认上传路径为 Windows/POSIX 绝对路径，且当前进程可读取普通文件。 */
export async function assertReadableAbsoluteFile(
  input: unknown,
): Promise<string> {
  const path = requireNonBlankString(input, "OneBot 11 upload path");
  if (!win32.isAbsolute(path) && !posix.isAbsolute(path)) {
    throw new TypeError("OneBot 11 upload path must be absolute");
  }

  try {
    await access(path, constants.R_OK);
    if (!(await stat(path)).isFile()) {
      throw new Error("path is not a regular file");
    }
  } catch (error) {
    throw new TypeError("OneBot 11 upload path must be a readable file", {
      cause: error,
    });
  }
  return path;
}

/** 防御具体实现返回无效 Action 或替换 Operations 分配的 echo。 */
export function assertExtensionAction(
  input: unknown,
  expectedEcho: string,
): asserts input is OneBot11Action {
  const action = assertExactObject(
    input,
    ["action", "params", "echo"],
    "OneBot 11 extension action",
  );
  requireNonBlankString(action.action, "OneBot 11 extension action name");
  if (
    typeof action.params !== "object" ||
    action.params === null ||
    Array.isArray(action.params)
  ) {
    throw new TypeError("OneBot 11 extension params must be an object");
  }
  if (action.echo !== expectedEcho) {
    throw new TypeError(
      "OneBot 11 extension action must preserve the assigned echo",
    );
  }
}
