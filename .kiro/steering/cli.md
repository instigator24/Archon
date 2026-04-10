---
inclusion: fileMatch
fileMatchPattern: 'packages/cli/**/*.ts'
---

# CLI Conventions

## Commands

```bash
bun run cli workflow list [--json]
bun run cli workflow run <name> [message] [--branch <branch>] [--from-branch <base>] [--no-worktree] [--resume]
bun run cli workflow status [runId]
bun run cli isolation list
bun run cli isolation cleanup [days]
bun run cli complete <branch-name> [--force]
```

## Startup Behavior

1. Deletes `process.env.DATABASE_URL` (prevent target repo's DB from leaking in)
2. Loads `~/.archon/.env` with `override: true`
3. Smart Claude auth default: if no `CLAUDE_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, sets `CLAUDE_USE_GLOBAL_AUTH=true`

## WorkflowRunOptions

`--branch` + `--no-worktree` and `--from` + `--no-worktree` and `--resume` + `--branch` are mutually exclusive (enforced in CLI pre-flight and `workflowRunCommand`).

Default: creates worktree with auto-generated branch name (isolation by default).

## Git Repo Requirement

Workflow and isolation commands resolve CWD to git repo root via `git rev-parse --show-toplevel`.

## CLIAdapter

Implements `IPlatformAdapter`. Streams to stdout. `getStreamingMode()` defaults to `'batch'`. No auth — CLI is local only. Conversation ID format: `cli-{timestamp}-{random6}`.

## Anti-patterns

- Never run CLI commands outside a git repository (workflow/isolation commands fail)
- Never set `DATABASE_URL` in `~/.archon/.env` to point at a target app's database
- Never use `--force` on `complete` unless branch is truly safe to delete
- Never add interactive prompts — use flags for all options (non-interactive tool)
