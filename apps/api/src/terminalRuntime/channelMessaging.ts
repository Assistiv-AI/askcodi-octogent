import { type ChannelMessageType, parseChannelMessageEnvelope } from "@octogent/core";

import { logVerbose } from "../logging";
import type { ChannelMessage, PersistedTerminal, TerminalSession } from "./types";

export const createChannelMessaging = (deps: {
  terminals: Map<string, PersistedTerminal>;
  sessions: Map<string, TerminalSession>;
  writeInput: (terminalId: string, data: string) => boolean;
}) => {
  const { terminals, sessions, writeInput } = deps;
  const channelQueues = new Map<string, ChannelMessage[]>();
  let channelMessageCounter = 0;

  const deliverChannelMessages = (terminalId: string): number => {
    const queue = channelQueues.get(terminalId);
    if (!queue || queue.length === 0) {
      return 0;
    }

    const session = sessions.get(terminalId);
    if (!session) {
      return 0;
    }

    const undelivered = queue.filter((m) => !m.delivered);
    if (undelivered.length === 0) {
      return 0;
    }

    // Compose all pending messages into a single prompt injection.
    const lines = undelivered.map(
      (m) => `[Channel message from ${m.fromTerminalId}]: ${m.content}`,
    );
    const prompt = `${lines.join("\n")}\r`;

    logVerbose(`[Channel] Delivering ${undelivered.length} message(s) to ${terminalId}`);

    for (const m of undelivered) {
      m.delivered = true;
    }

    writeInput(terminalId, prompt);
    return undelivered.length;
  };

  return {
    sendChannelMessage(
      toTerminalId: string,
      fromTerminalId: string,
      content: string,
      explicitType?: ChannelMessageType,
    ): ChannelMessage | null {
      if (!terminals.has(toTerminalId)) {
        return null;
      }

      // Senders can pass an explicit `type`; otherwise we infer it from a
      // leading `DONE:` / `BLOCKED:` / `ASSIGN:` / `INFO:` prefix in the
      // content. The stored `content` is unchanged so existing prompts that
      // grep the body keep working; the typed field is for new consumers
      // (octoboss router, swarm parent auto-cleanup, future UI).
      const type = explicitType ?? parseChannelMessageEnvelope(content).type;

      channelMessageCounter += 1;
      const message: ChannelMessage = {
        messageId: `msg-${channelMessageCounter}`,
        fromTerminalId,
        toTerminalId,
        content,
        type,
        timestamp: new Date().toISOString(),
        delivered: false,
      };

      const queue = channelQueues.get(toTerminalId) ?? [];
      queue.push(message);
      channelQueues.set(toTerminalId, queue);

      logVerbose(
        `[Channel] Queued message ${message.messageId} type=${type} from=${fromTerminalId} to=${toTerminalId}`,
      );

      // If the target session is idle, deliver immediately.
      const targetSession = sessions.get(toTerminalId);
      if (targetSession && targetSession.agentState === "idle") {
        deliverChannelMessages(toTerminalId);
      }

      return message;
    },

    listChannelMessages(terminalId: string): ChannelMessage[] {
      return channelQueues.get(terminalId) ?? [];
    },

    deliverChannelMessages,
  };
};
