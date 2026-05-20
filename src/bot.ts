/**
 * Debox bot lifecycle. Supports polling (long-poll loop against
 * `/openapi/bot/getUpdates`) and webhook (verifies `X-API-KEY` and
 * dispatches to the bridge).
 */

import type { DeboxApi, DeboxIncomingMessage, DeboxUpdate } from './debox-api.js';
import type { DeboxBridge } from './bridge.js';

export interface BotOptions {
  api: DeboxApi;
  bridge: DeboxBridge;
  mode: 'polling' | 'webhook';
  /** Public HTTPS URL Debox should POST updates to (webhook mode). */
  webhookUrl?: string;
  /** Expected `X-API-KEY` header on inbound webhook requests. Must equal the bot's API key. */
  webhookSecret?: string;
  pollingInterval?: number;
  logger?: (message: string) => void;
  reportRuntimeError?: (error: string | null) => void;
}

export interface WebhookRequestLike {
  headers: Record<string, string>;
  rawBody: string;
}

export interface WebhookResponseLike {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

export class DeboxBot {
  private readonly api: DeboxApi;
  private readonly bridge: DeboxBridge;
  private readonly log: (message: string) => void;
  private running = false;
  private pollAbort: AbortController | undefined;

  constructor(private readonly options: BotOptions) {
    this.api = options.api;
    this.bridge = options.bridge;
    this.log =
      options.logger ?? ((msg) => console.log(`[debox-bot] ${msg}`));
  }

  async start(): Promise<void> {
    try {
      const info = await this.api.getBotInfo();
      const label = info.name ?? info.user_id ?? 'unknown';
      this.log(`connected (bot: ${label})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`getBotInfo failed (continuing): ${message}`);
    }
    this.running = true;

    if (this.options.mode === 'webhook') {
      await this.startWebhook();
    } else {
      // Fire-and-forget polling loop so start() returns immediately.
      void this.startPolling().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`polling task crashed: ${message}`);
      });
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.pollAbort?.abort();

    if (this.options.mode === 'webhook') {
      try {
        await this.api.deleteWebhook();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`deleteWebhook failed (continuing): ${message}`);
      }
    }
    this.log('bot stopped');
  }

  // ── Polling ────────────────────────────────────────────────────────

  private async startPolling(): Promise<void> {
    // Polling mode requires the webhook config to be cleared, otherwise
    // Debox routes updates to the webhook and our polling returns empty.
    try {
      await this.api.deleteWebhook();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`deleteWebhook (during polling start) failed: ${message}`);
    }
    this.log('polling mode started');
    this.pollAbort = new AbortController();

    while (this.running) {
      try {
        const updates = await this.api.getUpdates({
          timeoutSec: 30,
          signal: this.pollAbort.signal,
        });
        this.options.reportRuntimeError?.(null);
        for (const update of updates) {
          void this.handleUpdate(update);
        }
      } catch (error) {
        if (!this.running) break;
        if (error instanceof DOMException && error.name === 'AbortError') break;
        const message = error instanceof Error ? error.message : String(error);
        this.log(`polling error: ${message}`);
        this.options.reportRuntimeError?.(`polling error: ${message}`);
        await new Promise((resolve) =>
          setTimeout(resolve, this.options.pollingInterval ?? 1000),
        );
      }
    }
  }

  // ── Webhook ────────────────────────────────────────────────────────

  private async startWebhook(): Promise<void> {
    const url = this.options.webhookUrl;
    if (!url) {
      throw new Error(
        'webhook_url is required in webhook mode (gateway derives this from publicAgentBaseUrl).',
      );
    }
    try {
      await this.api.setWebhook(url);
      this.log(`webhook mode started → ${url}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`setWebhook failed (continuing — assume console-configured): ${message}`);
    }
  }

  /**
   * Called by the gateway's webhook dispatcher when running embedded.
   * Verifies the `X-API-KEY` header (if a secret is configured) and
   * dispatches the update asynchronously.
   */
  async handleWebhookRequest(req: WebhookRequestLike): Promise<WebhookResponseLike> {
    if (this.options.webhookSecret) {
      const got =
        req.headers['x-api-key'] ?? req.headers['X-API-KEY'.toLowerCase()];
      if (got !== this.options.webhookSecret) {
        return { status: 401, body: 'unauthorized' };
      }
    }
    let update: DeboxUpdate;
    try {
      update = JSON.parse(req.rawBody) as DeboxUpdate;
    } catch {
      return { status: 400, body: 'invalid json' };
    }
    void this.handleUpdate(update);
    return {
      status: 200,
      body: '{"ok":true}',
      headers: { 'content-type': 'application/json' },
    };
  }

  // ── Dispatch ───────────────────────────────────────────────────────

  private async handleUpdate(update: DeboxUpdate): Promise<void> {
    const message = extractMessage(update);
    if (!message) {
      this.log(`inbound update: no message extracted from ${safeStringify(update)}`);
      return;
    }
    try {
      await this.bridge.handleIncoming(message);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.log(`error handling inbound: ${text}`);
    }
  }
}

/**
 * Per the Debox docs, both polling and webhook updates wrap the message
 * in a `message` field on the update object. We also accept an unwrapped
 * shape (where `chat` / `from` live directly on the update) for forward
 * compatibility with surfaces that may flatten the payload.
 */
const extractMessage = (update: DeboxUpdate): DeboxIncomingMessage | undefined => {
  if (update.message) return update.message;
  const flatChat = (update as { chat?: unknown }).chat;
  const flatFrom = (update as { from?: unknown }).from;
  if (flatChat || flatFrom) {
    return update as unknown as DeboxIncomingMessage;
  }
  return undefined;
};

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};
