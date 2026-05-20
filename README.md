# Debox Channel Adapter

`@openhermit/channel-debox` connects an OpenHermit agent to [Debox](https://debox.pro/) via the official bot API. The plugin is **not bundled** in the CLI — operators install it explicitly when they want Debox support.

## v0.1 scope

- Text inbound and outbound (markdown parse mode)
- DMs (`chat_type: private`) and group chats (`chat_type: group`)
- Both connection modes:
  - **polling** — long-poll `/openapi/bot/getUpdates` against Debox
  - **webhook** — Debox POSTs to a public URL on the gateway
- Optional allow-lists (`allowed_senders`, `allowed_group_ids`)
- `/new` command to start a fresh conversation in the current chat

Out of scope for v0.1: media uploads, inline-button callbacks, streaming edits, the `setup` wizard (use config-based provisioning for now).

## Setup (operator)

1. Open **BotMother** inside the Debox app (search address `0xda521900ac9dfeff8a8e692bb627ff8cd80a7b28`) and create a bot. Set its name, avatar, and description.
2. In **Bot management**, copy the bot's **API Key** (and optionally **App Secret**).
3. Pick a mode:
   - **polling**: leave the webhook URL empty in the console.
   - **webhook**: configure an HTTPS URL pointing at your gateway (`<public_gateway_url>/api/agents/<agent>/channels/debox/webhook`).

## Loading the plugin

Add the package to your gateway config:

```jsonc
// ~/.openhermit/gateway/config.json
{
  "channelPackages": ["@openhermit/channel-debox"]
}
```

Then install it next to the CLI:

```bash
npm install -g @openhermit/channel-debox
```

For monorepo dev, the workspace resolution handles it.

On gateway boot the plugin loader picks up the package via dynamic import and registers the `debox` manifest as an `external` origin. Owners add Debox per agent from the admin UI's "Add channel" picker.

### Config shape

```jsonc
{
  "enabled": true,
  "api_key": "...",               // required
  "api_secret": "...",            // optional
  "base_url": "https://open.debox.pro", // optional override
  "mode": "polling",              // "polling" | "webhook"
  "webhook_url": "...",           // webhook mode only; derived from gateway public URL when absent
  "allowed_senders": ["u_..."],   // optional allow-list (sender IDs)
  "allowed_group_ids": ["gid"]    // optional allow-list (group IDs)
}
```

## Standalone mode

`@openhermit/channel-debox` can also run as its own process talking to a remote OpenHermit gateway. Set the following env vars and run `node dist/index.js`:

```bash
DEBOX_API_KEY=...
DEBOX_API_SECRET=...                  # optional
DEBOX_MODE=polling                    # or "webhook"
DEBOX_WEBHOOK_URL=https://your.url    # webhook mode
DEBOX_WEBHOOK_PORT=8443               # webhook mode (when self-hosting the listener)
DEBOX_POLLING_INTERVAL=1000           # ms (polling mode)
OPENHERMIT_AGENT_URL=https://gateway.example/api/agents/<agent>
OPENHERMIT_AGENT_TOKEN=...            # the agent's `debox` token
```

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```

The package depends on `@openhermit/protocol` and `@openhermit/shared` from the [openhermit monorepo](https://github.com/HCF-STUDIOS/openhermit) via local `file:` paths. To develop locally, clone openhermit as a sibling directory of this repo:

```
parent/
├── openhermit/
└── openhermit-channel-debox/    <- this repo
```

Once `@openhermit/protocol` and `@openhermit/shared` are published to npm, the `file:` references will be replaced with proper version ranges.

## API references

- Debox Node SDK docs — <https://docs.debox.pro/NODE-SDK>
- OpenHermit channel plugin contract — <https://github.com/HCF-STUDIOS/openhermit/blob/main/docs/channel-plugin-design.md>

## License

MIT
