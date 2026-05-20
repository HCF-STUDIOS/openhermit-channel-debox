/**
 * Standalone-mode config loader. When the package is run directly (e.g.
 * `npx @openhermit/channel-debox` or `node dist/index.js`), it reads
 * environment variables. When loaded through the gateway plugin system,
 * the manifest's `start()` receives a typed config object instead.
 */

export interface DeboxAdapterConfig {
  /** Debox bot API key (X-API-KEY). */
  apiKey: string;
  /** Optional Debox App Secret. */
  apiSecret?: string;
  /** Override `https://open.debox.pro` if you proxy. */
  baseUrl?: string;
  /** Connection mode. `webhook` requires a public HTTPS URL. */
  mode: 'polling' | 'webhook';
  /** Agent connection. */
  agentBaseUrl: string;
  agentToken: string;
  /** Webhook settings (webhook mode only). */
  webhookUrl?: string;
  webhookPort?: number;
  /** Polling cadence between failures (ms). Default 1000. */
  pollingInterval?: number;
}

const required = (name: string, value: string | undefined): string => {
  if (!value) throw new Error(`${name} environment variable is required.`);
  return value;
};

export const loadConfig = async (): Promise<DeboxAdapterConfig> => {
  const apiKey = required('DEBOX_API_KEY', process.env.DEBOX_API_KEY);
  const mode = (process.env.DEBOX_MODE as 'polling' | 'webhook') ?? 'polling';
  const agentBaseUrl = required(
    'OPENHERMIT_AGENT_URL',
    process.env.OPENHERMIT_AGENT_URL,
  );
  const agentToken = required(
    'OPENHERMIT_AGENT_TOKEN',
    process.env.OPENHERMIT_AGENT_TOKEN,
  );

  const config: DeboxAdapterConfig = {
    apiKey,
    mode,
    agentBaseUrl,
    agentToken,
  };

  if (process.env.DEBOX_API_SECRET) config.apiSecret = process.env.DEBOX_API_SECRET;
  if (process.env.DEBOX_BASE_URL) config.baseUrl = process.env.DEBOX_BASE_URL;
  if (process.env.DEBOX_WEBHOOK_URL) config.webhookUrl = process.env.DEBOX_WEBHOOK_URL;
  if (process.env.DEBOX_WEBHOOK_PORT) {
    config.webhookPort = Number.parseInt(process.env.DEBOX_WEBHOOK_PORT, 10);
  }
  if (process.env.DEBOX_POLLING_INTERVAL) {
    config.pollingInterval = Number.parseInt(
      process.env.DEBOX_POLLING_INTERVAL,
      10,
    );
  }

  return config;
};
