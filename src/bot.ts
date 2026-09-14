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
  /** Base delay after the first polling failure (ms). Doubles per consecutive failure. */
  pollingInterval?: number;
  /**
   * Ceiling for the exponential backoff after consecutive polling errors (ms).
   * Debox's getUpdates returns HTTP 200 with a "Bad Request" body for a bot
   * whose token/config is invalid, which the API client throws on. Without
   * backoff the loop re-polls every `pollingInterval` (~1s) forever — across a
   * few bad bots that becomes a request storm that saturates the gateway's
   * event loop / DB pool. Backing off to this ceiling caps a stuck bot to one
   * poll per interval; a recovering bot resets to full speed on the first good
   * poll. Defaults to 60s.
   */
  maxRetryDelayMs?: number;
  logger?: (message: string) => void;
  reportRuntimeError?: (error: string | null) => void;
}

/**
 * Exponential backoff with jitter for a retry loop. `attempt` is the 1-based
 * consecutive-failure count. Returns `baseMs * 2^(attempt-1)` capped at `maxMs`
 * then ±20% jitter so many bots failing at once don't retry in lockstep.
 * `random` is injectable for deterministic tests.
 */
export function computeBackoffMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const n = Math.max(1, Math.floor(attempt));
  const capped = Math.min(baseMs * 2 ** Math.min(n - 1, 20), maxMs);
  return Math.round(capped * (0.8 + random() * 0.4));
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
  /** Consecutive failed polls; drives the exponential backoff, reset on success. */
  private consecutiveErrors = 0;

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
        this.consecutiveErrors = 0;
        this.options.reportRuntimeError?.(null);
        for (const update of updates) {
          void this.handleUpdate(update);
        }
      } catch (error) {
        if (!this.running) break;
        if (error instanceof DOMException && error.name === 'AbortError') break;
        this.consecutiveErrors += 1;
        const delay = computeBackoffMs(
          this.consecutiveErrors,
          this.options.pollingInterval ?? 1000,
          this.options.maxRetryDelayMs ?? 60_000,
        );
        const message = error instanceof Error ? error.message : String(error);
        this.log(`polling error: ${message} (retry in ${delay}ms, streak ${this.consecutiveErrors})`);
        this.options.reportRuntimeError?.(`polling error: ${message}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
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
