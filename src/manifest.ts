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

  secretKeys: [
    { key: 'DEBOX_API_KEY', label: 'API Key', placeholder: 'Enter Debox bot API key' },
    { key: 'DEBOX_API_SECRET', label: 'App Secret (optional)', placeholder: 'Enter Debox App Secret' },
  ],
  configFields: [
    {
      kind: 'select',
      key: 'mode',
      label: 'Mode',
      defaultValue: 'polling',
      options: [
        { value: 'polling', label: 'Polling' },
        { value: 'webhook', label: 'Webhook' },
      ],
    },
    {
      kind: 'webhook_url',
      label: 'Webhook URL',
      help: 'Configure this URL in Debox bot console. Inbound requests are verified by matching X-API-KEY against the bot key.',
      showWhen: { field: 'mode', equals: 'webhook' },
    },
    {
      kind: 'text',
      key: 'base_url',
      label: 'Base URL (optional)',
      placeholder: 'https://open.debox.pro',
      help: 'Override the default Debox API endpoint.',
    },
    {
      kind: 'string_list',
      key: 'allowed_senders',
      label: 'Allowed sender IDs (optional)',
      placeholder: 'comma-separated, e.g. u_abc, u_xyz',
      help: 'Leave blank to accept all senders.',
    },
    {
      kind: 'string_list',
      key: 'allowed_group_ids',
      label: 'Allowed group IDs (optional)',
      placeholder: 'comma-separated, e.g. gid_123, gid_456',
      help: 'Leave blank to accept all groups.',
    },
  ],
  defaultConfig: {
    api_key: '${{DEBOX_API_KEY}}',
    api_secret: '${{DEBOX_API_SECRET}}',
    mode: 'polling',
  },

  start: async (rawConfig, context) => {
    const config = rawConfig as DeboxRuntimeConfig;
    const log = (msg: string): void => context.logger('debox', msg);
    // Strip out unresolved `${{SECRET}}` placeholders left over when the
    // operator hasn't set the corresponding secret yet — treat those as
    // unset rather than passing the literal placeholder downstream.
    const isPlaceholder = (s: string | undefined): boolean =>
      typeof s === 'string' && /^\$\{\{\w+\}\}$/.test(s.trim());
    const apiKey = isPlaceholder(config.api_key) ? '' : (config.api_key?.trim() ?? '');
    const apiSecret = isPlaceholder(config.api_secret) ? undefined : config.api_secret;

    if (!apiKey) {
      log('missing api_key — channel disabled until configured');
      return undefined;
    }

    const apiOptions: ConstructorParameters<typeof DeboxApi>[0] = { apiKey };
    if (apiSecret) apiOptions.apiSecret = apiSecret;
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
