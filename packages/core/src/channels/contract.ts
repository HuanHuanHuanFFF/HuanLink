/**
 * Channel Contract 的统一导出入口。
 *
 * 本合同只表达跨平台的公共聊天语义；QQ 戳一戳、群管理等平台专属
 * 动作应由对应 Adapter 的结构化 Tool 或受控 CLI 暴露，不得塞入
 * Core 消息字段。
 */

export * from "./channel-instance.js";
export * from "./channel-message.js";
export * from "./channel-adapter.js";
export * from "./channel-validation.js";
export * from "./channel-trigger.js";
