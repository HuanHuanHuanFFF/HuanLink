/**
 * Channel Contract v1 的迁移期统一导出入口。
 *
 * 当前正式运行链仍使用 `channels/types.ts` 中的 Demo 合同；本入口先让
 * OneBot Adapter 和 Server 可以分批迁移。全部调用方切换后会删除旧合同，
 * 并去掉类型名中的 `V1` 后缀，不长期维护两套 Channel API。
 *
 * 本合同只表达跨平台的公共聊天语义。QQ 戳一戳、群管理等平台专属动作
 * 应由对应 Adapter 的结构化 Tool 或受控 CLI 暴露，不得塞入 Core 消息字段。
 */

export * from "./channel-instance-v1.js";
export * from "./channel-message-v1.js";
export * from "./channel-adapter-v1.js";
export * from "./channel-validation-v1.js";
