---
inclusion: fileMatch
fileMatchPattern: 'packages/core/src/db/**/*.ts,migrations/**/*.sql'
---

# Database Conventions

## 8 Tables (all prefixed `remote_agent_`)

`codebases`, `conversations`, `sessions`, `isolation_environments`, `workflow_runs`, `workflow_events`, `messages`, `codebase_env_vars`.

## IDatabase Interface

Auto-detects: PostgreSQL if `DATABASE_URL` set, SQLite (`~/.archon/archon.db`) otherwise. Use `$1`, `$2` placeholders (work for both). Use `getDialect()` for dialect-specific expressions: `generateUuid()`, `now()`, `jsonMerge()`, `jsonArrayContains()`, `nowMinusDays()`.

## Import Pattern — Namespaced Exports

```typescript
import * as conversationDb from '@archon/core/db/conversations';
import * as sessionDb from '@archon/core/db/sessions';
import * as codebaseDb from '@archon/core/db/codebases';
```

## Error Handling

- INSERT: wrap in try/catch, log with `db_insert_failed`, throw descriptive error
- UPDATE: verify via `rowCount` — `updateConversation()` throws `ConversationNotFoundError` when `rowCount === 0`
- Sessions are immutable — never mutated, only deactivated and replaced. Audit trail via `parent_session_id` + `transition_reason`
- Conversations use soft-delete: always filter `deleted_at IS NULL` in user-facing queries

## Anti-patterns

- Never `SELECT *` in production queries on large tables
- Never write raw SQL outside `packages/core/src/db/` modules
- Never bypass `IDatabase` interface from other packages
- Never assume `rows[0]` exists without null-checking
- Never use `RETURNING *` in UPDATE when only checking success — check `rowCount`
