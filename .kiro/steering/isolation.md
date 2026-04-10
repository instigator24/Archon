---
inclusion: fileMatch
fileMatchPattern: 'packages/isolation/**/*.ts,packages/git/**/*.ts'
---

# Isolation & Git Conventions

## Branded Types

Always use branded constructors from `@archon/git` — they reject empty strings at runtime:

```typescript
import { toRepoPath, toBranchName, toWorktreePath } from '@archon/git';
import type { RepoPath, BranchName, WorktreePath } from '@archon/git';
```

Git operations return `GitResult<T>` discriminated union: `{ ok: true; value: T }` or `{ ok: false; error: GitError }`. Always check `.ok` before accessing `.value`.

## IsolationResolver — 7-Step Resolution Order

1. Existing env — reuse if worktree still exists on disk
2. No codebase — skip isolation, return `status: 'none'`
3. Workflow reuse — find active env with same `(codebaseId, workflowType, workflowId)`
4. Linked issue sharing — PR reuses worktree from linked issue
5. PR branch adoption — find existing worktree by branch name
6. Limit check + auto-cleanup — if at `maxWorktrees` (25), try `makeRoom()` first
7. Create new — `provider.create()` then `store.create()`; orphan cleanup on DB failure

## Error Handling

```typescript
import { classifyIsolationError, isKnownIsolationError } from '@archon/isolation';
// Known errors → user-friendly message + block
// Unknown errors → re-throw as crash
```

`IsolationBlockedError` signals ALL message handling must stop — user already notified.

## Safety Rules

- NEVER run `git clean -fd` — permanently deletes untracked files
- Always use `execFileAsync` (from `@archon/git/exec`), never `exec` or `execSync`
- `hasUncommittedChanges()` returns `true` on unexpected errors (conservative)
- Worktree paths: `~/.archon/workspaces/{owner}/{repo}/worktrees/{branch}`

## Architecture

- `@archon/git` — zero `@archon/*` dependencies
- `@archon/isolation` — depends only on `@archon/git` + `@archon/paths`
- `IIsolationStore` injected into resolver — never call DB directly from git package
- Stale env cleanup is best-effort: `markDestroyedBestEffort()` logs but never throws

## Anti-patterns

- Never call `git` via `exec()` or shell string — always `execFileAsync('git', [...args])`
- Never treat `IsolationBlockedError` as recoverable
- Never use plain `string` where `RepoPath` / `BranchName` / `WorktreePath` is expected
- Never skip `isKnownIsolationError()` check — unknown errors must propagate as crashes
