/**
 * Channel plugin manifest for Debox.
 *
 * Loaded by the OpenHermit gateway when `@openhermit/channel-debox` is
 * listed under `channelPackages` in gateway config. See
 * https://github.com/HCF-STUDIOS/openhermit/blob/main/docs/channel-plugin-design.md.
 */
import type { ChannelManifest } from '@openhermit/protocol';

import { DeboxApi } from './debox-api.js';
import { DeboxBridge } from './bridge.js';
import { DeboxBot } from './bot.js';

interface DeboxRuntimeConfig {
  enabled?: boolean;
  /** Debox bot API key (X-API-KEY). Required. */
  api_key: string;
  /** Optional Debox App Secret. Stored on the manifest for future signing. */
  api_secret?: string;
  /** Override the default `https://open.debox.pro` base URL. */
  base_url?: string;
  /** `polling` (default) or `webhook`. */
  mode?: 'polling' | 'webhook';
  /** Explicit webhook URL. If unset and mode=webhook, the manifest derives it from `publicAgentBaseUrl`. */
  webhook_url?: string;
  /** Restrict inbound to these sender IDs. */
  allowed_senders?: string[];
  /** Restrict inbound to these group IDs. */
  allowed_group_ids?: string[];
}

const manifest: ChannelManifest = {
  manifestVersion: 1,
  key: 'debox',
  namespace: 'debox',
  displayName: 'Debox',

  start: async (rawConfig, context) => {
    const config = rawConfig as DeboxRuntimeConfig;
    const log = (msg: string): void => context.logger('debox', msg);
    const apiKey = config.api_key?.trim() ?? '';

    if (!apiKey) {
      log('missing api_key — channel disabled until configured');
      return undefined;
    }

    const apiOptions: ConstructorParameters<typeof DeboxApi>[0] = { apiKey };
    if (config.api_secret) apiOptions.apiSecret = config.api_secret;
    if (config.base_url) apiOptions.baseUrl = config.base_url;
    const api = new DeboxApi(apiOptions);

    const bridgeOptions: ConstructorParameters<typeof DeboxBridge>[2] = {};
    if (config.allowed_senders) bridgeOptions.allowedSenders = config.allowed_senders;
    if (config.allowed_group_ids) bridgeOptions.allowedGroupIds = config.allowed_group_ids;

    const bridge = new DeboxBridge(
      api,
      {
        baseUrl: context.agentBaseUrl,
        token: context.agentTokens['debox'] ?? '',
      },
      bridgeOptions,
      log,
    );

    const mode = config.mode ?? 'polling';
    const botOptions: ConstructorParameters<typeof DeboxBot>[0] = {
      api,
      bridge,
      mode,
      logger: log,
      reportRuntimeError: context.reportRuntimeError,
    };
    if (mode === 'webhook') {
      let url: string;
      if (config.webhook_url) {
        url = config.webhook_url;
      } else if (context.publicAgentBaseUrl === context.agentBaseUrl) {
        throw new Error(
          'Debox webhook mode needs a public URL. Either set OPENHERMIT_GATEWAY_PUBLIC_URL on the gateway or set webhook_url in the channel config.',
        );
      } else {
        url = `${context.publicAgentBaseUrl}/channels/debox/webhook`;
      }
      botOptions.webhookUrl = url;
      // Debox sends inbound webhooks with the bot's own X-API-KEY, so
      // verifying inbound = matching the bot's apiKey.
      botOptions.webhookSecret = apiKey;
    }

    const bot = new DeboxBot(botOptions);
    await bot.start();

    return {
      name: 'debox',
      outbound: bridge,
      stop: () => bot.stop(),
      ...(mode === 'webhook'
        ? { handleWebhook: (req) => bot.handleWebhookRequest(req) }
        : {}),
    };
  },
};

export default manifest;
