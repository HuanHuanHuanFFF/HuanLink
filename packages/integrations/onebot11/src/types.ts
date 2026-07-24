import type { RuntimeLogger } from "@huanlink/core";

import type { OneBot11Action, OneBot11JsonObject } from "./codec.js";

export type ParseOneBot11GroupMessageOptions = {
  commandPrefix: string;
};

export type OneBot11ChannelErrorListener = (error: Error) => void;

export type ForwardWebSocketOneBot11TransportOptions = {
  url: string;
  accessToken?: string;
  requestTimeoutMs?: number;
  reconnectDelaysMs?: readonly number[];
  onError?: OneBot11ChannelErrorListener;
  logger?: RuntimeLogger;
};

export type OneBot11EventListener = (
  event: OneBot11JsonObject,
) => Promise<void> | void;

export type OneBot11ActionContext = {
  conversationId: string;
  logPayload?: unknown;
};

export interface OneBot11Transport {
  start(): Promise<void>;
  close(): Promise<void>;
  onEvent(listener: OneBot11EventListener): () => void;
  sendAction(
    action: OneBot11Action,
    context: OneBot11ActionContext,
  ): Promise<void>;
}

export type OneBot11ChannelAdapterOptions =
  ParseOneBot11GroupMessageOptions & {
    transport: OneBot11Transport;
    onError?: OneBot11ChannelErrorListener;
    logger?: RuntimeLogger;
  };

export type ForwardWebSocketOneBot11ChannelOptions =
  ParseOneBot11GroupMessageOptions &
    ForwardWebSocketOneBot11TransportOptions;
