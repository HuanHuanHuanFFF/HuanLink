import type { RuntimeLogger } from "@huanlink/core";

import type { OneBot11Action, OneBot11JsonObject } from "./codec.js";
import type {
  OneBot11FileUploadExtension,
  OneBot11ForwardMessageExtension,
} from "./operation-contracts.js";

/** 旧版群消息解析在 B07 前继续使用的命令前缀配置。 */
export type ParseOneBot11GroupMessageOptions = {
  /** 旧 Demo 用于识别并移除命令文本的固定前缀。 */
  commandPrefix: string;
};

/** 接收 OneBot Channel 或 Transport 非致命运行错误的观察者。 */
export type OneBot11ChannelErrorListener = (error: Error) => void;

/** 正向 WebSocket Transport 的连接、超时、重连和日志依赖。 */
export type ForwardWebSocketOneBot11TransportOptions = {
  /** OneBot 11 正向 WebSocket 地址。 */
  url: string;
  /** 可选 Bearer Access Token。 */
  accessToken?: string;
  /** 等待单次 Action 响应的正整数毫秒数。 */
  requestTimeoutMs?: number;
  /** 按尝试次数选取的非负重连延迟；超过长度后重复使用最后一项。 */
  reconnectDelaysMs?: readonly number[];
  onError?: OneBot11ChannelErrorListener;
  logger?: RuntimeLogger;
};

/** 接收 OneBot 主动上报事件的监听器。 */
export type OneBot11EventListener = (
  event: OneBot11JsonObject,
) => Promise<void> | void;

/** 为 Action 日志和错误提供其目标会话，不参与协议编码。 */
export type OneBot11ActionContext = {
  conversationId: string;
};

/**
 * Adapter 依赖的 OneBot 传输边界。
 * Transport 负责连接、事件流和 Action/响应关联，不理解 Channel 业务消息。
 */
export interface OneBot11Transport {
  /** 建立或复用当前连接。 */
  start(): Promise<void>;
  /** 幂等关闭连接并结束待处理 Action。 */
  close(): Promise<void>;
  /** 订阅 OneBot 主动上报事件。 */
  onEvent(listener: OneBot11EventListener): () => void;
  /** 发送带唯一 echo 的 Action，并等待对应完整响应。 */
  sendAction(
    action: OneBot11Action,
    context: OneBot11ActionContext,
  ): Promise<OneBot11JsonObject>;
}

/** B07 前旧版 OneBot Adapter 的构造依赖。 */
export type OneBot11ChannelAdapterOptions =
  ParseOneBot11GroupMessageOptions & {
    transport: OneBot11Transport;
    onError?: OneBot11ChannelErrorListener;
    logger?: RuntimeLogger;
  };

/** Channel Contract V1 OneBot Adapter 的实例标识和运行依赖。 */
export type OneBot11ChannelAdapterV1Options = {
  channelId: string;
  accountId?: string;
  transport: OneBot11Transport;
  fileUpload?: OneBot11FileUploadExtension;
  forwardMessages?: OneBot11ForwardMessageExtension;
  onError?: OneBot11ChannelErrorListener;
  logger?: RuntimeLogger;
};

/** 旧版正向 WebSocket 兼容外观的组合配置。 */
export type ForwardWebSocketOneBot11ChannelOptions =
  ParseOneBot11GroupMessageOptions &
    ForwardWebSocketOneBot11TransportOptions;

/** 正向 WebSocket Transport 与 V1 Adapter 的组合配置。 */
export type ForwardWebSocketOneBot11ChannelV1Options =
  ForwardWebSocketOneBot11TransportOptions & {
    channelId: string;
    accountId?: string;
    fileUpload?: OneBot11FileUploadExtension;
    forwardMessages?: OneBot11ForwardMessageExtension;
  };
