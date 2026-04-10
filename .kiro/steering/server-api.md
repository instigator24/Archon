---
inclusion: fileMatch
fileMatchPattern: 'packages/server/**/*.ts'
---

# Server API Conventions

## Hono Framework

CORS: allow-all for single-developer tool (override with `WEB_UI_ORIGIN`). All new/modified routes must use `registerOpenApiRoute(createRoute({...}), handler)` with Zod schemas.

## SSE Streaming

Always check `stream.closed` before writing. Use `stream.onAbort()` for cleanup. `SSETransport` manages stream registry; `removeStream()` accepts `expectedStream` reference to prevent race conditions.

## Webhook Signature Verification

Always use `c.req.text()` for raw webhook body — JSON.parse separately. HMAC-SHA256 with `timingSafeEqual`. Return 200 immediately, process async.

## Auto Port Allocation

Main repo: `PORT` env var or `3090`. Worktrees: hash-based port in 3190–4089 range (deterministic per path). Override: `PORT=4000`.

## Static SPA Fallback

Use `import.meta.dir` (absolute) NOT relative paths — `bun --filter @archon/server start` changes CWD.

## Key Routes

| Method         | Path                             | Purpose                 |
| -------------- | -------------------------------- | ----------------------- |
| GET            | `/api/conversations`             | List conversations      |
| POST           | `/api/conversations/:id/message` | Send message            |
| GET            | `/api/stream/:id`                | SSE stream              |
| GET/PUT/DELETE | `/api/workflows/:name`           | Workflow CRUD           |
| POST           | `/api/workflows/validate`        | Validate YAML in-memory |
| GET            | `/api/commands`                  | List commands           |
| POST           | `/webhooks/github`               | GitHub webhook          |

## Anti-patterns

- Never use `c.req.json()` for webhooks — verify signature against raw body
- Never expose API keys in JSON error responses
- Never serve static files with relative paths
- Never skip `stream.closed` check before writing SSE
- Never call platform adapters directly from route handlers — use `handleMessage()` + lock manager
