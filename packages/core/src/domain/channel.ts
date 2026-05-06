// Structured types let routers and hooks (octoboss decisions, swarm parent
// auto-cleanup, future UI badges) react to a message without string-matching
// the body. The set is intentionally small; widen it only when a real consumer
// needs to distinguish a new case.
export const CHANNEL_MESSAGE_TYPES = ["DONE", "BLOCKED", "ASSIGN", "INFO"] as const;
export type ChannelMessageType = (typeof CHANNEL_MESSAGE_TYPES)[number];

export const isChannelMessageType = (value: unknown): value is ChannelMessageType =>
  typeof value === "string" && (CHANNEL_MESSAGE_TYPES as readonly string[]).includes(value);

export type ChannelMessage = {
  messageId: string;
  fromTerminalId: string;
  toTerminalId: string;
  content: string;
  // Optional so old persisted records and old API clients keep working. When
  // absent, consumers should fall back to `parseChannelMessageEnvelope` on the
  // content. Senders may pass an explicit type; otherwise the runtime infers
  // it on receipt.
  type?: ChannelMessageType;
  timestamp: string;
  delivered: boolean;
};

const TYPE_PREFIXES: ReadonlyArray<{ type: ChannelMessageType; prefix: string }> =
  CHANNEL_MESSAGE_TYPES.map((type) => ({ type, prefix: `${type}:` }));

/**
 * Infer the message type from a leading prefix. The body returned is the
 * content with the prefix stripped and any leading whitespace trimmed. When
 * no prefix matches, the type is `INFO` and the body is the original content.
 *
 * This is used for back-compat with senders that historically encoded the
 * type in the body (e.g. swarm workers reporting `DONE: fixed validation`).
 */
export const parseChannelMessageEnvelope = (
  content: string,
): { type: ChannelMessageType; body: string } => {
  for (const { type, prefix } of TYPE_PREFIXES) {
    if (content.startsWith(prefix)) {
      const body = content.slice(prefix.length).replace(/^\s+/, "");
      return { type, body };
    }
  }
  return { type: "INFO", body: content };
};
