import { OneBot11ChannelAdapter } from "./channel-adapter.js";
import { ForwardWebSocketOneBot11Transport } from "./forward-websocket-transport.js";
import { createRedactingOneBot11RuntimeLogger } from "./runtime-log-secrets.js";
import type { ForwardWebSocketOneBot11ChannelOptions } from "./types.js";

/**
 * B02 迁移期兼容外观。
 *
 * Server 仍按旧 Demo `ChannelAdapter` 创建该类；连接状态已经归
 * `ForwardWebSocketOneBot11Transport`，群文本映射归
 * `OneBot11ChannelAdapter`。B04/B05 完成新合同和 Server 装配后移除此名称。
 */
export class ForwardWebSocketOneBot11Channel extends OneBot11ChannelAdapter {
  constructor(options: ForwardWebSocketOneBot11ChannelOptions) {
    const logger = createRedactingOneBot11RuntimeLogger(
      options.logger,
      options.url,
      options.accessToken,
    );
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
