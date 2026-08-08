/**
 * Channel Contract v1 的统一导出入口。
 *
 * `V1` 后缀表示合同版本，不表示仍有一套旧合同并行运行。本合同只表达
 * 跨平台的公共聊天语义；QQ 戳一戳、群管理等平台专属动作应由对应
 * Adapter 的结构化 Tool 或受控 CLI 暴露，不得塞入 Core 消息字段。
 */

export * from "./channel-instance-v1.js";
export * from "./channel-message-v1.js";
export * from "./channel-adapter-v1.js";
export * from "./channel-validation-v1.js";
export * from "./channel-trigger-v1.js";
