import { NoopRuntimeLogger } from "@huanlink/core";

import { OneBot11ChannelAdapter } from "./channel-adapter.js";
import { OneBot11ChannelAdapterV1 } from "./channel-adapter-v1.js";
import { ForwardWebSocketOneBot11Transport } from "./forward-websocket-transport.js";
import type {
  ForwardWebSocketOneBot11ChannelOptions,
  ForwardWebSocketOneBot11ChannelV1Options,
} from "./types.js";

/**
 * B02 迁移期兼容外观。
 *
 * Server 仍按旧 Demo `ChannelAdapter` 创建该类；连接状态已经归
 * `ForwardWebSocketOneBot11Transport`，群文本映射归
 * `OneBot11ChannelAdapter`。B07 完成新合同的 Server 装配后移除此名称。
 */
export class ForwardWebSocketOneBot11Channel extends OneBot11ChannelAdapter {
  /** 按旧版 Options 组装 Transport 和兼容 Adapter，不在此实现协议逻辑。 */
  constructor(options: ForwardWebSocketOneBot11ChannelOptions) {
    const logger = options.logger ?? new NoopRuntimeLogger();
    const transport = new ForwardWebSocketOneBot11Transport({
      url: options.url,
      ...(options.accessToken === undefined
        ? {}
        : { accessToken: options.accessToken }),
      ...(options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.reconnectDelaysMs === undefined
        ? {}
        : { reconnectDelaysMs: options.reconnectDelaysMs }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
      logger,
    });
    super({
      commandPrefix: options.commandPrefix,
      transport,
      ...(options.onError === undefined ? {} : { onError: options.onError }),
      logger,
    });
  }
}

/**
 * 组装使用正向 WebSocket 的 Channel Contract V1 Adapter。
 * 本函数只负责依赖创建和配置传递，连接与消息行为分别留在 Transport 和 Adapter。
 */
export function createForwardWebSocketOneBot11ChannelAdapterV1(
  options: ForwardWebSocketOneBot11ChannelV1Options,
): OneBot11ChannelAdapterV1 {
  const logger = options.logger ?? new NoopRuntimeLogger();
  const transport = new ForwardWebSocketOneBot11Transport({
    url: options.url,
    ...(options.accessToken === undefined
      ? {}
      : { accessToken: options.accessToken }),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.reconnectDelaysMs === undefined
      ? {}
      : { reconnectDelaysMs: options.reconnectDelaysMs }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    logger,
  });
  return new OneBot11ChannelAdapterV1({
    channelId: options.channelId,
    ...(options.accountId === undefined ? {} : { accountId: options.accountId }),
    transport,
    ...(options.fileUpload === undefined
      ? {}
      : { fileUpload: options.fileUpload }),
    ...(options.forwardMessages === undefined
      ? {}
      : { forwardMessages: options.forwardMessages }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    logger,
  });
}
