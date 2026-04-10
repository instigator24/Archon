---
inclusion: fileMatch
fileMatchPattern: 'packages/adapters/**/*.ts'
---

# Adapters Conventions

## Key Patterns

- Auth is inside adapters — every adapter checks authorization before calling `onMessage()`. Silent rejection (no error response), log with masked user ID: `userId.slice(0, 4) + '***'`.
- Whitelist parsing in constructor — parse env var (`SLACK_ALLOWED_USER_IDS`, `TELEGRAM_ALLOWED_USER_IDS`, `GITHUB_ALLOWED_USERS`, `DISCORD_ALLOWED_USER_IDS`) using a co-located `parseAllowedXxx()` function. Empty list = open access.
- Lazy logger pattern — ALL adapter files use module-level `cachedLog` + `getLog()` getter so test mocks intercept `createLogger` before instantiation. Never initialize logger at module scope.

## Two Handler Patterns (Both Valid)

- Chat adapters (Slack, Telegram, Discord): `onMessage(handler)` — adapter owns the event loop (polling/WebSocket), fires registered callback. Lock manager lives in the server's callback closure.
- Forge adapters (GitHub): `handleWebhook(payload, signature)` — server HTTP route calls directly, returns 200 immediately. Full pipeline inside adapter. Lock manager injected in constructor.

## Message Splitting

Use shared `splitIntoParagraphChunks(message, maxLength)` from `../../utils/message-splitting`. Limits: Slack 12000, Telegram 4096, GitHub 65000, Discord 2000.

## Conversation ID Formats

| Platform | Format                 | Example                     |
| -------- | ---------------------- | --------------------------- |
| Slack    | `channel:thread_ts`    | `C123ABC:1234567890.123456` |
| Telegram | numeric chat ID string | `"1234567890"`              |
| GitHub   | `owner/repo#number`    | `"acme/api#42"`             |
| Web      | user-provided string   | `"my-chat"`                 |
| Discord  | channel ID string      | `"987654321098765432"`      |

## Interface: `IPlatformAdapter`

Required methods: `sendMessage`, `ensureThread`, `getStreamingMode`, `getPlatformType`, `start`, `stop`. Optional: `sendStructuredEvent`, `emitRetract`. `IWebPlatformAdapter` extends with web-only methods; type guard: `isWebAdapter()`.

## Anti-patterns

- Never put auth logic outside the adapter (no auth middleware in server routes)
- Never throw from `onMessage` handlers
- Never use `exec` — always `execFileAsync` for subprocess calls
- Never add a new method to `IPlatformAdapter` unless ALL adapters need it; use optional methods for platform-specific capabilities
- GitHub only responds to `issue_comment.created` — NOT `issues.opened` / `pull_request.opened` (descriptions contain docs, not commands)
