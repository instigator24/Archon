---
inclusion: always
---

# Archon — Project Overview & Core Principles

## What Is This

Remote Agentic Coding Platform: control AI coding assistants (Claude Code SDK, Codex SDK) remotely from Slack, Telegram, GitHub, Discord, CLI, and Web UI. Built with Bun + TypeScript + SQLite/PostgreSQL. Single-developer tool for AI-assisted development. Architecture prioritizes simplicity, flexibility, and user control.

## Monorepo Layout (Bun Workspaces)

```
packages/
├── paths/       # @archon/paths — Path resolution + Pino logger (zero @archon/* deps)
├── git/         # @archon/git — Git operations (depends on @archon/paths only)
├── isolation/   # @archon/isolation — Worktree isolation (depends on @archon/git + @archon/paths)
├── workflows/   # @archon/workflows — Workflow engine (depends on @archon/git + @archon/paths)
├── core/        # @archon/core — Business logic, DB, orchestration, AI clients
├── cli/         # @archon/cli — Command-line interface
├── adapters/    # @archon/adapters — Platform adapters (Slack, Telegram, GitHub, Discord)
├── server/      # @archon/server — Hono HTTP server, Web adapter, API routes
└── web/         # @archon/web — React frontend (Vite + Tailwind v4 + shadcn/ui + Zustand)
```

## Engineering Principles (Apply by Default)

- KISS: straightforward control flow over clever meta-programming
- YAGNI: no speculative abstractions without a concrete caller
- DRY + Rule of Three: extract shared utilities only after 3+ occurrences
- SRP + ISP: one concern per module; extend via narrow interfaces, never fat interfaces
- Fail Fast: throw early with clear errors, never silently swallow or broaden permissions
- Determinism: reproducible commands, deterministic tests, no flaky timing
- Reversibility: small scope, clear blast radius, define rollback path before merging

## Type Safety (CRITICAL)

- Strict TypeScript configuration enforced
- All functions must have complete type annotations
- No `any` types without explicit justification
- Interfaces for all major abstractions
- Use `import type` for type-only imports

## Zod Schema Conventions

- Schema naming: camelCase with descriptive suffix (e.g., `workflowRunSchema`)
- Type derivation: always `z.infer<typeof schema>` — never hand-crafted parallel interfaces
- Import `z` from `@hono/zod-openapi` (not from `zod` directly)
- All new/modified API routes must use `registerOpenApiRoute(createRoute({...}), handler)`
- Route schemas in `packages/server/src/routes/schemas/`, engine schemas in `packages/workflows/src/schemas/`

## Import Patterns

```typescript
// ✅ Use `import type` for type-only imports
import type { IPlatformAdapter, Conversation } from '@archon/core';

// ✅ Specific named imports for values
import { handleMessage, ConversationLockManager } from '@archon/core';

// ✅ Namespace imports for submodules with many exports
import * as conversationDb from '@archon/core/db/conversations';
import * as git from '@archon/git';

// ✅ Direct subpath imports for workflow engine
import type { WorkflowDeps } from '@archon/workflows/deps';
import { executeWorkflow } from '@archon/workflows/executor';

// ❌ Never generic import for main package
import * as core from '@archon/core';

// ❌ In @archon/web, never import from @archon/workflows
// Use re-exports from @/lib/api instead
```

## Essential Commands

```bash
bun run dev              # Start server + Web UI (hot reload)
bun run test             # Run all tests (per-package isolation)
bun run type-check       # TypeScript checking
bun run lint             # ESLint (zero warnings enforced)
bun run format           # Prettier
bun run validate         # All four checks — run before every PR
```

NEVER run `bun test` from repo root — causes ~135 mock pollution failures. Always `bun run test`.

## Git Workflow

- `main` is the release branch — never commit directly
- `dev` is the working branch — all feature work branches off `dev`
- NEVER run `git clean -fd` — permanently deletes untracked files
- Use `@archon/git` functions; use `execFileAsync` (not `exec`) for git subprocesses

## Logging

Structured logging with Pino. Event naming: `{domain}.{action}_{state}` (e.g., `session.create_failed`). Lazy logger pattern in all modules — never initialize at module scope. Never log API keys, tokens, user message content, or PII.
