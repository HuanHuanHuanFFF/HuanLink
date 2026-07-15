export type ChannelTrigger = {
  kind: "mention" | "command";
  text: string;
};

export type InboundChannelMessage = {
  channel: "onebot11";
  conversationId: string;
  messageId: string;
  senderId: string;
  senderName: string;
  text: string;
  receivedAt: string;
  trigger?: ChannelTrigger;
};

export type ChannelConversationRoute = Pick<
  InboundChannelMessage,
  "channel" | "conversationId"
>;

export type ChannelMessageListener = (
  message: InboundChannelMessage
) => Promise<void> | void;

export interface ChannelAdapter {
  readonly channel: InboundChannelMessage["channel"];
  start(): Promise<void>;
  close(): Promise<void>;
  onMessage(listener: ChannelMessageListener): () => void;
  sendText(conversationId: string, text: string): Promise<void>;
}
