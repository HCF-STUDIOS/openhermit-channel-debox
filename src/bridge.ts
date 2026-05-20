/**
 * Bridge between Debox messages and the OpenHermit agent API.
 */

import { randomUUID } from 'node:crypto';

import { AgentLocalClient, parseSseFrames } from '@openhermit/sdk';
import type {
  ChannelMessageAction,
  ChannelOutbound,
  ChannelOutboundResult,
} from '@openhermit/protocol';

import type {
  DeboxApi,
  DeboxChatType,
  DeboxIncomingMessage,
} from './debox-api.js';
import { formatAgentResponse } from './formatting.js';

/** Agent-emitted sentinel meaning "do not reply in this group". */
const NO_REPLY_TAG = '<NO_REPLY>';

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

interface TurnResult {
  text: string | undefined;
  error: string | undefined;
}

/** Cache key for the chat-id ↔ session-id mapping. Encodes chat type. */
const chatCacheKey = (chatId: string, chatType: DeboxChatType): string =>
  `${chatType}:${chatId}`;

export interface DeboxBridgeOptions {
  /** Only accept messages from these user IDs. Empty/undefined = allow all. */
  allowedSenders?: string[];
  /** Only accept group messages from these group IDs. Empty/undefined = allow all. */
  allowedGroupIds?: string[];
}

export class DeboxBridge implements ChannelOutbound {
  readonly channel = 'debox';

  private readonly client: AgentLocalClient;
  private readonly clientToken: string;
  private readonly log: (message: string) => void;
  private readonly lastEventIds = new Map<string, number>();
  /** sessionId per chat (DM or group). */
  private readonly chatSessions = new Map<string, string>();
  /** Serialize handling per chat. */
  private readonly chatLocks = new Map<string, Promise<void>>();
  private readonly allowedSenders: Set<string> | undefined;
  private readonly allowedGroupIds: Set<string> | undefined;

  constructor(
    private readonly debox: DeboxApi,
    clientOptions: { baseUrl: string; token: string },
    options: DeboxBridgeOptions = {},
    logger?: (message: string) => void,
  ) {
    this.client = new AgentLocalClient(clientOptions);
    this.clientToken = clientOptions.token;
    this.log = logger ?? ((msg) => console.log(`[debox-bridge] ${msg}`));
    this.allowedSenders = options.allowedSenders?.length
      ? new Set(options.allowedSenders)
      : undefined;
    this.allowedGroupIds = options.allowedGroupIds?.length
      ? new Set(options.allowedGroupIds)
      : undefined;
  }

  // ── Outbound: implements ChannelOutbound.send ─────────────────────

  async send(params: {
    sessionId: string;
    to: string;
    text: string;
    actions?: ChannelMessageAction[];
  }): Promise<ChannelOutboundResult> {
    // `to` encodes the chat type: "group:<gid>" or "private:<uid>".
    // Bare ids default to "private" for backwards convenience.
    const { chatId, chatType } = parseChatTarget(params.to);
    try {
      const chunks = formatAgentResponse(params.text);
      let lastMessageId: string | undefined;
      for (const chunk of chunks) {
        const result = await this.debox.sendMessage({
          chatId,
          chatType,
          content: chunk.text,
          parseMode: chunk.parseMode,
        });
        if (result?.message_id) lastMessageId = String(result.message_id);
      }
      const out: ChannelOutboundResult = { success: true };
      if (lastMessageId) out.messageId = lastMessageId;
      return out;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`failed to send message to ${params.to}: ${message}`);
      return { success: false, error: message };
    }
  }

  // ── Inbound: called by the bot lifecycle ───────────────────────────

  async handleIncoming(payload: DeboxIncomingMessage): Promise<void> {
    const chatId = payload.chat?.id;
    const chatType = payload.chat?.type;
    if (!chatId || !chatType) {
      this.log(`dropping inbound: missing chat id/type (payload: ${safeStringify(payload)})`);
      return;
    }

    if (chatType === 'group' && this.allowedGroupIds && !this.allowedGroupIds.has(chatId)) {
      this.log(`dropping inbound from non-allowed group ${chatId}`);
      return;
    }
    const senderId = payload.from?.user_id;
    if (senderId && this.allowedSenders && !this.allowedSenders.has(senderId)) {
      this.log(`dropping inbound from non-allowed sender ${senderId}`);
      return;
    }

    const lockKey = chatCacheKey(chatId, chatType);
    const prev = this.chatLocks.get(lockKey) ?? Promise.resolve();
    const current = prev.then(
      () => this.handleIncomingInner(chatId, chatType, payload),
      () => this.handleIncomingInner(chatId, chatType, payload),
    );
    this.chatLocks.set(lockKey, current.catch(() => {}));
    await current;
  }

  private async handleIncomingInner(
    chatId: string,
    chatType: DeboxChatType,
    payload: DeboxIncomingMessage,
  ): Promise<void> {
    const text = (payload.text ?? '').trim();
    if (!text) return;

    if (text === '/new') {
      await this.handleNew(chatId, chatType);
      return;
    }

    const sessionId = await this.getSessionId(chatId, chatType);
    await this.sendToAgent(chatId, chatType, sessionId, text, payload);
  }

  private async handleNew(chatId: string, chatType: DeboxChatType): Promise<void> {
    const key = chatCacheKey(chatId, chatType);
    const oldSessionId = this.chatSessions.get(key);
    if (oldSessionId) {
      try {
        await this.client.checkpointSession(oldSessionId, { reason: 'new_session' });
      } catch {
        // Old session may not exist; ignore.
      }
      this.lastEventIds.delete(oldSessionId);
    }
    const newSessionId = DeboxBridge.generateSessionId();
    this.chatSessions.set(key, newSessionId);
    await this.debox.sendMessage({
      chatId,
      chatType,
      content: 'New conversation started.',
      parseMode: 'text',
    });
  }

  private static generateSessionId(): string {
    return `debox:${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  }

  private async getSessionId(
    chatId: string,
    chatType: DeboxChatType,
  ): Promise<string> {
    const key = chatCacheKey(chatId, chatType);
    const cached = this.chatSessions.get(key);
    if (cached) return cached;

    try {
      const sessions = await this.client.listSessions({
        channel: 'debox',
        metadata:
          chatType === 'group'
            ? { debox_group_id: chatId }
            : { debox_user_id: chatId },
        limit: 1,
      });
      if (sessions.length > 0) {
        const sessionId = sessions[0]!.sessionId;
        this.chatSessions.set(key, sessionId);
        return sessionId;
      }
    } catch {
      // Server unavailable — fall through to a fresh session.
    }

    const sessionId = DeboxBridge.generateSessionId();
    this.chatSessions.set(key, sessionId);
    return sessionId;
  }

  private async ensureSession(
    sessionId: string,
    chatId: string,
    chatType: DeboxChatType,
    payload: DeboxIncomingMessage,
  ): Promise<void> {
    const metadata: Record<string, string | number> = {};
    if (chatType === 'group') {
      metadata.debox_group_id = chatId;
    } else {
      metadata.debox_user_id = chatId;
    }
    const senderId = payload.from?.user_id;
    if (senderId) metadata.debox_from_user_id = senderId;

    await this.client.openSession({
      sessionId,
      source: {
        kind: 'channel',
        interactive: true,
        platform: 'debox',
        type: chatType === 'group' ? 'group' : 'direct',
      },
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
  }

  private async sendToAgent(
    chatId: string,
    chatType: DeboxChatType,
    sessionId: string,
    text: string,
    payload: DeboxIncomingMessage,
  ): Promise<void> {
    // The Debox getUpdates schema doesn't surface a mention flag, so we
    // treat groups as un-mentioned (the agent decides whether to reply)
    // and DMs as always mentioned.
    const mentioned =
      chatType !== 'group' ||
      Boolean(payload.mention_users && payload.mention_users.length > 0);

    await this.ensureSession(sessionId, chatId, chatType, payload);

    const senderId = payload.from?.user_id;
    const senderPayload = senderId
      ? {
          sender: {
            channel: 'debox' as const,
            channelUserId: senderId,
          },
        }
      : {};

    const postResult = await this.client.postMessage(sessionId, {
      text,
      mentioned,
      ...senderPayload,
    });

    if (!(postResult as { triggered?: boolean }).triggered) return;

    const result = await this.waitForAgentResponse(sessionId);
    if (result.error && !result.text) {
      await this.debox.sendMessage({
        chatId,
        chatType,
        content: `Error: ${result.error}`,
        parseMode: 'text',
      });
    } else if (result.text) {
      const target = encodeChatTarget(chatId, chatType);
      await this.send({ sessionId, to: target, text: result.text });
    }
  }

  private async waitForAgentResponse(sessionId: string): Promise<TurnResult> {
    const eventsUrl = this.client.buildEventsUrl(sessionId);
    const lastEventId = this.lastEventIds.get(sessionId) ?? 0;

    const response = await fetch(eventsUrl, {
      headers: { authorization: `Bearer ${this.clientToken}` },
    });
    if (!response.ok || !response.body) {
      return {
        text: undefined,
        error: `Failed to open event stream (${response.status})`,
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let nextLastEventId = lastEventId;
    let sequenceResetChecked = false;
    let accumulatedText = '';
    let finalText: string | undefined;
    let error: string | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseFrames(buffer);
        buffer = parsed.remainder;
        let sawAgentEnd = false;

        for (const frame of parsed.frames) {
          if (frame.id !== undefined && frame.id <= nextLastEventId) continue;
          if (frame.id !== undefined) nextLastEventId = frame.id;

          if (frame.event === 'ready') {
            // Detect runner restart: ids may reset to 1 — drop the cursor in
            // that case so we don't silently skip every event.
            if (!sequenceResetChecked) {
              sequenceResetChecked = true;
              try {
                const data =
                  frame.data.length > 0
                    ? (JSON.parse(frame.data) as { nextEventId?: number })
                    : {};
                if (
                  typeof data.nextEventId === 'number' &&
                  data.nextEventId <= nextLastEventId
                ) {
                  nextLastEventId = 0;
                }
              } catch {
                // Ignore — fall back to stored cursor.
              }
            }
            continue;
          }
          if (frame.event === 'ping') continue;

          const payload =
            frame.data.length > 0
              ? (JSON.parse(frame.data) as Record<string, unknown>)
              : {};

          if (frame.event === 'text_delta') {
            accumulatedText += String(payload.text ?? '');
            continue;
          }
          if (frame.event === 'text_final') {
            finalText = String(payload.text ?? '').trim();
            continue;
          }
          if (frame.event === 'error') {
            error = String(payload.message ?? 'Unknown error');
            continue;
          }
          if (frame.event === 'agent_end') {
            sawAgentEnd = true;
            continue;
          }
        }

        if (sawAgentEnd) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    this.lastEventIds.set(sessionId, nextLastEventId);

    const responseText = finalText ?? (accumulatedText.trim() || undefined);
    if (responseText && responseText.trim() === NO_REPLY_TAG) {
      return { text: undefined, error: undefined };
    }
    return { text: responseText, error };
  }
}

/** Encode a chat target as `<type>:<id>` for ChannelOutbound.send().to. */
export const encodeChatTarget = (chatId: string, chatType: DeboxChatType): string =>
  `${chatType}:${chatId}`;

/** Inverse of `encodeChatTarget` — accepts a bare id as legacy "private". */
export const parseChatTarget = (target: string): { chatId: string; chatType: DeboxChatType } => {
  const colon = target.indexOf(':');
  if (colon === -1) return { chatId: target, chatType: 'private' };
  const prefix = target.slice(0, colon);
  const rest = target.slice(colon + 1);
  if (prefix === 'group') return { chatId: rest, chatType: 'group' };
  if (prefix === 'private') return { chatId: rest, chatType: 'private' };
  return { chatId: target, chatType: 'private' };
};
