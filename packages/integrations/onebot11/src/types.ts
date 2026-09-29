import type { RuntimeLogger } from "@huanlink/core";

import type { OneBot11Action, OneBot11JsonObject } from "./codec.js";
import type {
  OneBot11FileUploadExtension,
  OneBot11ForwardMessageExtension,
} from "./operation-contracts.js";

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
  /** 按尝试次数选取的非负重连延迟，超过长度后复用最后一项。 */
  reconnectDelaysMs?: readonly number[];
  onError?: OneBot11ChannelErrorListener;
  logger?: RuntimeLogger;
};

/** 接收 OneBot 主动上报事件的监听器。 */
export type OneBot11EventListener = (
  event: OneBot11JsonObject,
) => Promise<void> | void;

/** 为 Action 日志和错误提供目标会话，不参与协议编码。 */
export type OneBot11ActionContext = {
  conversationId: string;
};

/** Transport 负责连接、事件流和 Action/响应关联，不理解 Channel 业务消息。 */
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

/** 正式 OneBot 11 Adapter 的实例标识、扩展和运行依赖。 */
export type OneBot11ChannelAdapterOptions = {
  channelId: string;
  accountId?: string;
  transport: OneBot11Transport;
  fileUpload?: OneBot11FileUploadExtension;
  forwardMessages?: OneBot11ForwardMessageExtension;
  onError?: OneBot11ChannelErrorListener;
  logger?: RuntimeLogger;
};

/** 正向 WebSocket Transport 与正式 Adapter 的组合配置。 */
export type ForwardWebSocketOneBot11ChannelOptions =
  ForwardWebSocketOneBot11TransportOptions & {
    channelId: string;
    accountId?: string;
    fileUpload?: OneBot11FileUploadExtension;
    forwardMessages?: OneBot11ForwardMessageExtension;
  };
