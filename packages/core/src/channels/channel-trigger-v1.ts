import type { ChannelTriggerV1 } from "./channel-message-v1.js";

/** Adapter 从平台消息中提取、供 Channel 判断触发原因的临时事实。 */
export type ChannelTriggerSignalsV1 = {
  /** 平台消息是否明确提到了当前 Channel 实例。 */
  readonly mentionedSelf: boolean;
  /** 去除平台开头结构后可用于判断命令的连续文本。 */
  readonly leadingText?: string;
};

const CHANNEL_COMMAND_PATTERN_V1 = /^\/[\p{L}\p{N}_-]+(?=\s|$)/u;

/**
 * 根据平台无关信号判断 Channel 消息的触发原因。
 * 有效 `/命令` 优先于 mention；命令是否合法及如何执行由后续层判断。
 */
export function resolveChannelTriggerV1(
  signals: ChannelTriggerSignalsV1,
): ChannelTriggerV1 | undefined {
  const leadingText = signals.leadingText?.trimStart();
  if (
    leadingText !== undefined &&
    CHANNEL_COMMAND_PATTERN_V1.test(leadingText)
  ) {
    return { kind: "command" };
  }
  return signals.mentionedSelf ? { kind: "mention" } : undefined;
}
