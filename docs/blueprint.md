# Whitelist Message Forwarder — Bot specification

**Archetype:** workflow

**Voice:** professional and concise — write every user-facing message, button label, error, and empty state in this voice.

Automatically forwards messages from pre-approved users/groups to a designated Telegram channel, preserving original sender attribution and media types.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- Telegram channel curators
- content aggregators

## Success criteria

- All whitelisted messages appear in target channel within 5 seconds
- 100% sender attribution preservation
- Zero unauthorized messages forwarded

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Initiate setup flow to configure whitelist and target channel

## Flows

### message_forwarding
_Trigger:_ incoming_message

1. Check sender against persistent whitelist
2. If matched, forward to configured channel with original metadata
3. Log delivery status and retry on failure

_Data touched:_ whitelist, destination_channel

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

- **whitelist_entry** _(retention: persistent)_ — Authorized sender ID (user or group)
  - fields: telegram_id, type
- **destination_channel** _(retention: persistent)_ — Target Telegram channel ID for forwarding
  - fields: channel_id

## Integrations

- **Telegram** (required) — Message routing and forwarding
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Initial whitelist configuration
- Target channel selection

## Notifications

- Delivery failure logs with automatic retries
- Admin channel alerts for persistent errors

## Permissions & privacy

- Read-only access to whitelisted senders' messages
- Channel posting permissions for target audience

## Edge cases

- Handling Telegram's ephemeral message types
- Fallback formatting when exact forwarding fails
- Rate limiting with high-volume whitelists

## Required tests

- End-to-end forwarding test with 15+ message types
- Whitelist enforcement validation
- Persistence across service restarts

## Assumptions

- Owner will provide valid Telegram IDs during setup
- Channel has proper permissions for bot posts
