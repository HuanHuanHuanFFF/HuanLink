import type { RuntimeLogger } from "@huanlink/core";

export type ParseOneBot11GroupMessageOptions = {
  commandPrefix: string;
};

export type OneBot11ChannelErrorListener = (error: Error) => void;

export type ForwardWebSocketOneBot11ChannelOptions =
  ParseOneBot11GroupMessageOptions & {
    url: string;
    accessToken?: string;
    requestTimeoutMs?: number;
    reconnectDelaysMs?: readonly number[];
    onError?: OneBot11ChannelErrorListener;
    logger?: RuntimeLogger;
  };
