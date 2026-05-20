/**
 * Minimal Debox Bot API client. Uses `fetch` directly — no SDK dependency.
 *
 * Endpoints and field shapes follow https://docs.debox.pro/ApiOnePage.
 * Every request carries `X-API-KEY: <apiKey>`. The bot's optional
 * "App Secret" is accepted but not currently used in any signed request.
 */

const DEFAULT_BASE_URL = 'https://open.debox.pro';

export type DeboxChatType = 'private' | 'group';

/**
 * `parse_mode` values accepted by `bot/sendMessage`. These are
 * case-sensitive — `Markdown` and `MarkdownV2` use mixed case, `HTML`
 * is upper, and the rich-text token is `richtext` (one word).
 */
export type DeboxParseMode =
  | 'richtext'
  | 'text'
  | 'Markdown'
  | 'MarkdownV2'
  | 'HTML'
  | 'image'
  | 'video'
  | 'file';

/** Response from `POST /openapi/bot/getMe`. */
export interface DeboxBotInfo {
  user_id?: string;
  name?: string;
  address?: string;
  pic?: string;
  level?: number;
  level_icon?: string;
}

/**
 * Inbound message as wrapped in a Debox update. Field layout follows
 * https://docs.debox.pro/ApiOnePage#api-bot-getupdates — the chat id
 * lives under `chat.id`, sender under `from.user_id`, and the text in
 * `text` (NOT `message`, which was the previous (incorrect) guess).
 */
export interface DeboxIncomingMessage {
  message_id?: string;
  from?: { user_id?: string; name?: string; address?: string };
  chat?: { id?: string; type?: DeboxChatType };
  text?: string;
  parse_mode?: string;
  /** Not in the published schema, kept for forward-compat with mentions. */
  mention_users?: string[];
}

export interface DeboxUpdate {
  /** Per docs, updates carry a numeric `id`. `update_id` is kept as a fallback. */
  id?: number | string;
  update_id?: number;
  message?: DeboxIncomingMessage;
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

  /** Returns the bot's own profile. Used at startup as a connectivity probe. */
  async getBotInfo(): Promise<DeboxBotInfo> {
    return this.request<DeboxBotInfo>('POST', '/openapi/bot/getMe', {});
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
   * updates are available within `timeoutSec` seconds (range 1–60).
   *
   * Debox `getUpdates` is queue-style: each delivered update is removed
   * server-side, so there is no `offset` parameter (unlike Telegram).
   */
  async getUpdates(params?: {
    timeoutSec?: number;
    signal?: AbortSignal;
  }): Promise<DeboxUpdate[]> {
    const body: Record<string, unknown> = {
      timeout: params?.timeoutSec ?? 30,
    };
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
   * setWebhook / deleteWebhook are NOT in the published Debox API. The
   * webhook URL is configured on the bot's open-platform console; these
   * calls remain for callers that want to attempt remote re-sync and
   * are expected to 404 in current Debox versions (the caller logs and
   * carries on).
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
