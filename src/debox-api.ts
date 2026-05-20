/**
 * Minimal Debox Bot API client. Uses `fetch` directly — no SDK dependency.
 *
 * Authentication: every request carries `X-API-KEY: <apiKey>` (except
 * `/openapi/box/info` which is unauthenticated). The bot's "App Secret"
 * is held by the caller but the public docs are vague on what it
 * actually signs, so this client doesn't use it.
 *
 * Endpoints used here are taken from https://docs.debox.pro/NODE-SDK.
 */

const DEFAULT_BASE_URL = 'https://open.debox.pro';

export type DeboxChatType = 'private' | 'group';

export type DeboxParseMode =
  | 'text'
  | 'rich_text'
  | 'markdown'
  | 'markdown_v2'
  | 'html'
  | 'image'
  | 'video'
  | 'file';

export interface DeboxBotInfo {
  user_id?: string;
  username?: string;
  nickname?: string;
  avatar?: string;
  bio?: string;
}

export interface DeboxIncomingMessage {
  /** Inbound payload from a webhook or polling update. */
  from_user_id?: string;
  to_user_id?: string;
  group_id?: string;
  language?: string;
  /** Bot-mention-normalized text (mentions replaced). */
  message?: string;
  /** Raw text with `@<id>` mentions intact. */
  message_raw?: string;
  mention_users?: string[];
  message_id?: string;
  timestamp?: number;
  /** Some payloads pre-categorise the chat. */
  chat_type?: DeboxChatType;
}

export interface DeboxUpdate {
  /** Some surfaces use `update_id`, others `id`. We expose both, untouched. */
  update_id?: number;
  id?: number | string;
  message?: DeboxIncomingMessage;
  /** Future: callback_query for inline buttons. */
  [key: string]: unknown;
}

export interface SendMessageOptions {
  parseMode?: DeboxParseMode;
  /** Markup for inline buttons (passthrough — docs don't formalise the shape for Node). */
  replyMarkup?: unknown;
}

export interface SendMessageResult {
  message_id?: string;
  [key: string]: unknown;
}

interface DeboxBotEnvelope<T> {
  ok?: boolean;
  success?: boolean;
  result?: T;
  data?: T;
  code?: number | string;
  message?: string;
  msg?: string;
  error?: string;
}

export class DeboxApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly status: number,
    message: string,
  ) {
    super(`Debox API error (${method}, status ${status}): ${message}`);
    this.name = 'DeboxApiError';
  }
}

export interface DeboxApiOptions {
  apiKey: string;
  /** Optional App Secret. Stored on the client; not used in the current request flow but kept for future signing. */
  apiSecret?: string;
  /** Override the base URL (default `https://open.debox.pro`). */
  baseUrl?: string;
}

export class DeboxApi {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string | undefined;

  constructor(options: DeboxApiOptions) {
    if (!options.apiKey) {
      throw new Error('DeboxApi: apiKey is required');
    }
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  /** Probe endpoint that doesn't require auth — useful for health checks. */
  async getBotInfo(): Promise<DeboxBotInfo> {
    return this.request<DeboxBotInfo>('GET', '/openapi/box/info', undefined, {
      authenticated: false,
    });
  }

  async sendMessage(params: {
    chatId: string;
    chatType: DeboxChatType;
    content: string;
    parseMode?: DeboxParseMode;
    replyMarkup?: unknown;
  }): Promise<SendMessageResult> {
    const body: Record<string, unknown> = {
      chat_id: params.chatId,
      chat_type: params.chatType,
      content: params.content,
    };
    if (params.parseMode) body.parse_mode = params.parseMode;
    if (params.replyMarkup) body.reply_markup = params.replyMarkup;
    return this.request<SendMessageResult>(
      'POST',
      '/openapi/bot/sendMessage',
      body,
    );
  }

  /**
   * Long-poll for updates. Returns immediately with an empty list if no
   * updates are available within `timeoutSec` seconds. Pass the highest
   * `update_id` you've seen + 1 as `offset` to ack and advance.
   *
   * The Debox docs describe `GetUpdates`/`GetUpdatesChan` in the Node
   * SDK; the underlying HTTP endpoint here is best-effort and may need
   * adjustment once vendor docs settle.
   */
  async getUpdates(params?: {
    offset?: number;
    timeoutSec?: number;
    signal?: AbortSignal;
  }): Promise<DeboxUpdate[]> {
    const body: Record<string, unknown> = {
      timeout: params?.timeoutSec ?? 30,
    };
    if (params?.offset !== undefined) body.offset = params.offset;
    const opts: { authenticated?: boolean; signal?: AbortSignal } = {};
    if (params?.signal) opts.signal = params.signal;
    return this.request<DeboxUpdate[]>(
      'POST',
      '/openapi/bot/getUpdates',
      body,
      opts,
    );
  }

  /**
   * Register a webhook URL with Debox. The bot management console
   * normally handles this, but exposing the call lets callers re-sync
   * after a URL change.
   */
  async setWebhook(url: string): Promise<unknown> {
    return this.request<unknown>('POST', '/openapi/bot/setWebhook', { url });
  }

  async deleteWebhook(): Promise<unknown> {
    return this.request<unknown>('POST', '/openapi/bot/deleteWebhook', {});
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    options?: { authenticated?: boolean; signal?: AbortSignal },
  ): Promise<T> {
    const authenticated = options?.authenticated ?? true;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (authenticated) {
      headers['x-api-key'] = this.apiKey;
      if (this.apiSecret) headers['x-api-secret'] = this.apiSecret;
    }

    const init: RequestInit = { method, headers };
    if (body !== undefined && method !== 'GET') {
      init.body = JSON.stringify(body);
    }
    if (options?.signal) init.signal = options.signal;

    const response = await fetch(`${this.baseUrl}${path}`, init);
    let parsed: DeboxBotEnvelope<T> | undefined;
    try {
      parsed = (await response.json()) as DeboxBotEnvelope<T>;
    } catch {
      throw new DeboxApiError(path, response.status, 'invalid json response');
    }

    const ok = parsed.success === true || parsed.ok === true;
    if (!response.ok || !ok) {
      const detail =
        parsed.error ?? parsed.message ?? parsed.msg ?? response.statusText;
      throw new DeboxApiError(path, response.status, detail);
    }

    return (parsed.result ?? parsed.data) as T;
  }
}
