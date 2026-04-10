---
inclusion: fileMatch
fileMatchPattern: 'packages/core/src/orchestrator/**/*.ts,packages/core/src/handlers/**/*.ts,packages/core/src/state/**/*.ts'
---

# Orchestrator Conventions

## Message Flow — Routing Agent Architecture

```
Platform message → ConversationLockManager.acquireLock()
  → handleMessage()
    → Deterministic gate: 10 commands (help, status, reset, workflow, register-project, update-project, remove-project, commands, init, worktree)
    → Everything else → AI routing call:
      → buildFullPrompt() → AI responds with natural language ± /invoke-workflow
      → parseOrchestratorCommands() extracts structured commands
      → Dispatch workflow or send text to user
```

Lock manager returns `{ status: 'started' | 'queued-conversation' | 'queued-capacity' }`. Always use the return value — never call `isActive()` separately (TOCTOU race).

## Deterministic Commands

Only 10 commands bypass AI: `/help`, `/status`, `/reset`, `/workflow`, `/register-project`, `/update-project`, `/remove-project`, `/commands`, `/init`, `/worktree`. All other slash commands fall through to the AI router.

## Session Transitions

Sessions are immutable — never mutated, only deactivated and replaced. Audit trail via `parent_session_id` + `transition_reason`. Only `plan-to-execute` immediately creates a new session; all other triggers only deactivate.

`TransitionTrigger` values: `'first-message'`, `'plan-to-execute'`, `'isolation-changed'`, `'reset-requested'`, `'worktree-removed'`, `'conversation-closed'`, etc.

## Isolation Resolution

`validateAndResolveIsolation()` delegates to `IsolationResolver`. When blocked, `IsolationBlockedError` means user was notified — stop all further processing.

## Background Workflow Dispatch (Web only)

`dispatchBackgroundWorkflow()` creates hidden worker conversation, sets up event bridging, pre-creates workflow run row, fires-and-forgets `executeWorkflow()`.

## Lazy Logger Pattern

All files use deferred logger — NEVER initialize at module scope:

```typescript
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog() {
  return (cachedLog ??= createLogger('orchestrator'));
}
```

## Anti-patterns

- Never call `isActive()` then `acquireLock()` — race condition
- Never access `conversation.isolation_env_id` without going through the resolver
- Never skip `IsolationBlockedError` — must propagate to stop processing
- Never add platform-specific logic to orchestrator — use `IPlatformAdapter` only
- Never mutate sessions — always deactivate and create new linked session
- Never assume a slash command is deterministic — only the 10 listed above bypass AI
