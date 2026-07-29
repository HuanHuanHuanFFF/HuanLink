export type OneBot11JsonObject = Record<string, unknown>;

export type OneBot11Action = OneBot11JsonObject & {
  readonly action: string;
  readonly params: OneBot11JsonObject;
  readonly echo: string;
};

export type OneBot11MessageSegment = {
  readonly type: string;
  readonly data: Readonly<Record<string, string>>;
};

export type NormalizedOneBot11Message = {
  readonly content: string;
  readonly segments: readonly OneBot11MessageSegment[];
};

/**
 * 将 WebSocket 收到的 JSON 文本解析为 OneBot 11 帧对象。
 * JSON 无效或顶层值不是对象时抛出错误。
 */
export function parseOneBot11JsonFrame(raw: string): OneBot11JsonObject {
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      "Invalid OneBot 11 JSON frame: " + normalizeError(error).message,
    );
  }

  const object = asObject(frame);
  if (object === undefined) {
    throw new Error("Invalid OneBot 11 frame: expected an object");
  }
  return object;
}

/**
 * 将 OneBot 的 CQ 字符串或消息段数组规范为 CQ 字符串。
 * 字符串输入保持原样并解析消息段；数组输入校验后按 OneBot CQ 转义规则编码。
 * 输入格式无效或规范化后的内容为空时返回 undefined。
 */
export function normalizeOneBot11Message(
  input: unknown,
): NormalizedOneBot11Message | undefined {
  if (typeof input === "string") {
    if (input.length === 0) {
      return undefined;
    }
    return {
      content: input,
      segments: parseOneBot11CqSegments(input),
    };
  }
  if (!Array.isArray(input)) {
    return undefined;
  }

  const segments: OneBot11MessageSegment[] = [];
  for (const rawSegment of input) {
    const segment = asObject(rawSegment);
    const rawData =
      segment?.data === null ? {} : asObject(segment?.data);
    if (
      segment === undefined ||
      typeof segment.type !== "string" ||
      segment.type.length === 0 ||
      rawData === undefined
    ) {
      return undefined;
    }

    const data: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawData)) {
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        return undefined;
      }
      data[key] = String(value);
    }
    if (segment.type === "text" && typeof rawData.text !== "string") {
      return undefined;
    }
    segments.push({ type: segment.type, data });
  }

  const content = encodeOneBot11CqSegments(segments);
  return content.length === 0 ? undefined : { content, segments };
}

/**
 * 将 OneBot 11 消息段数组编码为 CQ 字符串。
 * 文本段直接写入正文，其他消息段编码为 [CQ:type,key=value]。
 */
export function encodeOneBot11CqSegments(
  segments: readonly OneBot11MessageSegment[],
): string {
  return segments
    .map((segment) => {
      if (segment.type === "text") {
        return escapeCqText(segment.data.text ?? "");
      }
      const parameters = Object.entries(segment.data)
        .map(([key, value]) => `,${key}=${escapeCqParameter(value)}`)
        .join("");
      return `[CQ:${segment.type}${parameters}]`;
    })
    .join("");
}

/**
 * 将 CQ 字符串解析为 OneBot 11 消息段数组。
 * CQ 码之间的普通文字会保留为 text 消息段，并恢复 CQ 转义字符。
 */
export function parseOneBot11CqSegments(
  content: string,
): OneBot11MessageSegment[] {
  const segments: OneBot11MessageSegment[] = [];
  const pattern = /\[CQ:([a-zA-Z0-9_-]+)((?:,[^\]]*)?)\]/gu;
  let cursor = 0;
  for (const match of content.matchAll(pattern)) {
    const index = match.index;
    if (index > cursor) {
      segments.push({
        type: "text",
        data: { text: unescapeCqText(content.slice(cursor, index)) },
      });
    }

    const data: Record<string, string> = {};
    const rawParameters = match[2];
    if (rawParameters !== undefined && rawParameters.length > 0) {
      for (const rawParameter of rawParameters.slice(1).split(",")) {
        const separator = rawParameter.indexOf("=");
        if (separator <= 0) {
          continue;
        }
        data[rawParameter.slice(0, separator)] = unescapeCqParameter(
          rawParameter.slice(separator + 1),
        );
      }
    }
    segments.push({ type: match[1]!, data });
    cursor = index + match[0].length;
  }

  if (cursor < content.length) {
    segments.push({
      type: "text",
      data: { text: unescapeCqText(content.slice(cursor)) },
    });
  }
  return segments;
}

/**
 * 创建旧版入口使用的 OneBot 11 群文本发送 Action。
 * 群号或 echo 无效时抛出错误；新版完整发送能力由 outbound-message-v1.ts 负责。
 */
export function createOneBot11SendGroupTextAction(
  conversationId: string,
  text: string,
  echo: string,
): OneBot11Action {
  const groupId = parseOutgoingGroupId(conversationId);
  if (groupId === undefined) {
    throw new Error("OneBot 11 group ID must be a safe positive integer string");
  }
  if (typeof echo !== "string" || echo.length === 0) {
    throw new Error("OneBot 11 action echo must be a non-empty string");
  }

  return {
    action: "send_group_msg",
    params: {
      group_id: groupId,
      message: [{ type: "text", data: { text } }],
    },
    echo,
  };
}

/**
 * 将外发会话中的群号转换为 OneBot 使用的安全正整数。
 * 非纯数字、零或超出 JavaScript 安全整数范围时返回 undefined。
 */
function parseOutgoingGroupId(input: string): number | undefined {
  if (!/^[1-9]\d*$/u.test(input)) {
    return undefined;
  }
  const parsed = Number(input);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * 将未知输入收窄为非空、非数组的 JSON 对象。
 */
function asObject(input: unknown): OneBot11JsonObject | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as OneBot11JsonObject)
    : undefined;
}

/**
 * 转义 CQ 普通文本中的 &、[ 和 ]，避免正文被误识别为 CQ 码。
 */
function escapeCqText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;");
}

/**
 * 转义 CQ 参数值；除普通文本字符外，额外转义用于分隔参数的逗号。
 */
function escapeCqParameter(value: string): string {
  return escapeCqText(value).replaceAll(",", "&#44;");
}

/**
 * 恢复 CQ 普通文本中的转义字符。
 */
function unescapeCqText(value: string): string {
  return value
    .replaceAll("&#91;", "[")
    .replaceAll("&#93;", "]")
    .replaceAll("&amp;", "&");
}

/**
 * 恢复 CQ 参数值中的逗号及普通文本转义字符。
 */
function unescapeCqParameter(value: string): string {
  return unescapeCqText(value.replaceAll("&#44;", ","));
}

/**
 * 将捕获到的任意异常值统一转换为标准 Error。
 */
function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
