import { NoopRuntimeLogger } from "@huanlink/core";

import { OneBot11ChannelAdapter } from "./channel-adapter.js";
import { ForwardWebSocketOneBot11Transport } from "./forward-websocket-transport.js";
import type { ForwardWebSocketOneBot11ChannelOptions } from "./types.js";

/**
 * 组装使用正向 WebSocket 的正式 OneBot 11 Channel Adapter。
 * 这里只创建 Transport 并注入 Adapter；连接状态与协议映射仍在各自模块内。
 */
export function createForwardWebSocketOneBot11ChannelAdapter(
  options: ForwardWebSocketOneBot11ChannelOptions,
): OneBot11ChannelAdapter {
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
  return new OneBot11ChannelAdapter({
    channelId: options.channelId,
    ...(options.accountId === undefined
      ? {}
      : { accountId: options.accountId }),
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
