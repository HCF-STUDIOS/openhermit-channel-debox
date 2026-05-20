import { pathToFileURL } from 'node:url';

import manifest from './manifest.js';
import { DeboxApi } from './debox-api.js';
import { DeboxBridge } from './bridge.js';
import { DeboxBot } from './bot.js';
import { loadConfig } from './config.js';

const log = (message: string): void => {
  console.log(`[openhermit-channel-debox] ${message}`);
};

/**
 * Try to pick up `loadEnv` from `@openhermit/shared` when it's available
 * (monorepo dev) so a sibling `.env` file is loaded. Silently skip when
 * the helper isn't installed (the common case for downstream consumers).
 */
const loadEnvIfAvailable = async (): Promise<void> => {
  try {
    const mod = (await import('@openhermit/shared')) as {
      loadEnv?: () => Promise<unknown>;
    };
    if (typeof mod.loadEnv === 'function') {
      await mod.loadEnv();
    }
  } catch {
    // Not installed — nothing to do.
  }
};

export const main = async (): Promise<void> => {
  await loadEnvIfAvailable();
  const config = await loadConfig();
  log(`mode: ${config.mode}`);
  log(`agent: ${config.agentBaseUrl}`);

  const apiOptions: ConstructorParameters<typeof DeboxApi>[0] = {
    apiKey: config.apiKey,
  };
  if (config.apiSecret) apiOptions.apiSecret = config.apiSecret;
  if (config.baseUrl) apiOptions.baseUrl = config.baseUrl;
  const api = new DeboxApi(apiOptions);

  const bridge = new DeboxBridge(
    api,
    { baseUrl: config.agentBaseUrl, token: config.agentToken },
    {},
    log,
  );

  const botOptions: ConstructorParameters<typeof DeboxBot>[0] = {
    api,
    bridge,
    mode: config.mode,
    logger: log,
  };
  if (config.webhookUrl) botOptions.webhookUrl = config.webhookUrl;
  if (config.pollingInterval) botOptions.pollingInterval = config.pollingInterval;
  // In standalone mode we accept any X-API-KEY equal to our bot key for
  // inbound webhook auth (Debox sends its own key).
  botOptions.webhookSecret = config.apiKey;

  const bot = new DeboxBot(botOptions);

  const shutdown = async (): Promise<void> => {
    log('shutting down...');
    await bot.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await bot.start();
};

export default manifest;
export { manifest };
export { DeboxApi } from './debox-api.js';
export { DeboxBridge } from './bridge.js';
export { DeboxBot } from './bot.js';
export type { DeboxAdapterConfig } from './config.js';
export type {
  DeboxBotInfo,
  DeboxChatType,
  DeboxIncomingMessage,
  DeboxParseMode,
  DeboxUpdate,
  SendMessageOptions,
  SendMessageResult,
} from './debox-api.js';
export type {
  ChannelOutbound,
  ChannelOutboundResult,
} from '@openhermit/protocol';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
