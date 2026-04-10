---
inclusion: fileMatch
fileMatchPattern: '**/*.test.ts,**/*.spec.ts'
---

# Testing Conventions

## CRITICAL: mock.module() Pollution

`mock.module()` permanently replaces modules in the process-wide cache. `mock.restore()` does NOT undo it.

Rules:

1. Never add `afterAll(() => mock.restore())` for `mock.module()` — it has no effect
2. Never have two test files `mock.module()` the same path with different implementations in the same `bun test` invocation
3. Use `spyOn()` for internal modules — `spy.mockRestore()` DOES work

```typescript
// ✅ spy (restorable)
import * as git from '@archon/git';
const spy = spyOn(git, 'checkout');
spy.mockRestore(); // works

// ✅ mock.module() for external deps (isolate in separate test file)
mock.module('@slack/bolt', () => ({ App: mock(() => mockApp) }));
```

## Test Batching

Each package splits tests into separate `bun test` invocations to prevent pollution. `@archon/core` has 7 batches, `@archon/workflows` has 5, `@archon/adapters` has 3, `@archon/isolation` has 3.

NEVER run `bun test` from repo root. Always: `bun run test`

## Mock Pattern for Lazy Loggers

Mock `@archon/paths` BEFORE importing the module under test:

```typescript
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
};
mock.module('@archon/paths', () => ({ createLogger: mock(() => mockLogger) }));

import { SlackAdapter } from './adapter'; // Import AFTER mock
```

## Database Test Mocking

```typescript
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';
const mockQuery = mock(() => Promise.resolve(createQueryResult([])));
mock.module('./connection', () => ({
  pool: { query: mockQuery },
  getDialect: () => mockPostgresDialect,
}));
```

## Anti-patterns

- Never import a module before all `mock.module()` calls for its dependencies
- Never test with real database or filesystem in unit tests
- Never add a new test file with conflicting `mock.module()` to an existing batch — create a new batch
