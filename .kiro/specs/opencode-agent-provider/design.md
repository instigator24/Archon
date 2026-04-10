# Design Document: OpenCode Agent Provider

## Overview

This design adds opencode as a third AI agent provider in Archon, alongside Claude and Codex. The opencode SDK (`@opencode-ai/sdk`) uses a client-server architecture: the SDK starts (or connects to) a local HTTP server and communicates via REST + SSE. The integration follows the established provider pattern — an `IAssistantClient` implementation in `@archon/core`, wired through the client factory, with the provider type propagated through Zod schemas, config types, model validation, and the DAG executor.

Key design decisions:

- **Client-server model**: Unlike Claude (subprocess) and Codex (in-process SDK), opencode runs a local server. The `OpenCodeClient` manages server lifecycle via `createOpencode()` and communicates through the SDK's typed client.
- **SSE event streaming**: The SDK's `event.subscribe()` provides real-time events. The client maps these to `MessageChunk` values using the same async generator pattern as Claude/Codex.
- **Session-based interaction**: opencode uses sessions (create → prompt → events). The client maps `resumeSessionId` to opencode session IDs for context continuity.
- **Minimal config surface**: opencode config mirrors the Codex pattern — `model` field plus provider-specific options. Claude-only options (hooks, mcp, skills, effort, thinking, sandbox, etc.) are warned and ignored.

## Architecture

```mermaid
graph TD
    subgraph "@archon/workflows"
        DE[DAG Executor] --> |resolveNodeProviderAndModel| MV[Model Validation]
        DE --> |getAssistantClient| WD[WorkflowDeps]
        WL[Workflow Loader] --> |parse provider enum| ZS[Zod Schemas]
    end

    subgraph "@archon/core"
        CF[Client Factory] --> CC[ClaudeClient]
        CF --> CX[CodexClient]
        CF --> OC[OpenCodeClient]
        CL[Config Loader] --> CT[Config Types]
    end

    subgraph "External"
        OC --> |@opencode-ai/sdk| OS[opencode server]
    end

    WD --> |factory call| CF
    DE --> |loadConfig| CL
```

The provider type `'opencode'` flows through these layers:

1. **Zod schemas** (`workflow.ts`, `dag-node.ts`) — accept `'opencode'` in provider enums
2. **Config types** (`config-types.ts`) — `MergedConfig.assistant` union includes `'opencode'`
3. **Config loader** (`config-loader.ts`) — merges `assistants.opencode` section
4. **Model validation** (`model-validation.ts`) — validates opencode/model compatibility
5. **DAG executor** (`dag-executor.ts`) — resolves provider, builds options, warns on unsupported features
6. **Client factory** (`factory.ts`) — instantiates `OpenCodeClient`
7. **OpenCodeClient** (`opencode.ts`) — implements `IAssistantClient` using `@opencode-ai/sdk`

## Components and Interfaces

### OpenCodeClient (`packages/core/src/clients/opencode.ts`)

Implements `IAssistantClient`. Mirrors the structure of `ClaudeClient` and `CodexClient`.

```typescript
import { createOpencode, createOpencodeClient } from '@opencode-ai/sdk';
import type { AssistantRequestOptions, IAssistantClient, MessageChunk, TokenUsage } from '../types';
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('client.opencode');
  return cachedLog;
}

export class OpenCodeClient implements IAssistantClient {
  private readonly retryBaseDelayMs: number;

  constructor(options?: { retryBaseDelayMs?: number }) {
    this.retryBaseDelayMs = options?.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: AssistantRequestOptions
  ): AsyncGenerator<MessageChunk> {
    // 1. Pre-spawn env-leak check (same pattern as Claude/Codex)
    // 2. Create or connect to opencode server via SDK
    // 3. Create or resume session
    // 4. Send prompt, subscribe to SSE events
    // 5. Map SDK events → MessageChunk yields
    // 6. Retry transient errors with exponential backoff
  }

  getType(): string {
    return 'opencode';
  }
}
```

**SDK interaction pattern:**

```typescript
// Start server + client (or connect to existing)
const { client, server } = await createOpencode({ config: { model: options?.model } });

// Create or resume session
const session = resumeSessionId
  ? await client.session.get({ path: { id: resumeSessionId } })
  : await client.session.create({ body: { title: 'archon-workflow' } });

// Send prompt and get response (synchronous wait)
const result = await client.session.prompt({
  path: { id: session.data.id },
  body: {
    parts: [{ type: 'text', text: prompt }],
    ...(options?.outputFormat ? { format: options.outputFormat } : {}),
  },
});

// Subscribe to SSE events for streaming
const events = await client.event.subscribe();
for await (const event of events.stream) {
  // Map event → MessageChunk
}
```

**Event mapping (SDK → MessageChunk):**

| SDK Event / Part Type  | MessageChunk Type                               | Notes                     |
| ---------------------- | ----------------------------------------------- | ------------------------- |
| `text` part            | `{ type: 'assistant', content }`                | Agent text response       |
| `tool-invocation` part | `{ type: 'tool', toolName, toolInput }`         | Tool call start           |
| `tool-result` part     | `{ type: 'tool_result', toolName, toolOutput }` | Tool call result          |
| `thinking` part        | `{ type: 'thinking', content }`                 | Reasoning output          |
| Response completion    | `{ type: 'result', sessionId, tokens, cost }`   | Session result with usage |
| Error event            | `{ type: 'system', content }`                   | Error notification        |

**Error classification** follows the same pattern as Claude/Codex:

```typescript
const RATE_LIMIT_PATTERNS = ['rate limit', 'too many requests', '429', 'overloaded'];
const AUTH_PATTERNS = ['unauthorized', 'authentication', 'invalid token', '401', '403'];
const CRASH_PATTERNS = ['exited with code', 'killed', 'signal', 'ECONNREFUSED'];

function classifyOpenCodeError(msg: string): 'rate_limit' | 'auth' | 'crash' | 'unknown' { ... }
```

**Retry logic**: Up to 3 retries with exponential backoff for transient errors (rate limit, crash). Auth errors are never retried.

### Client Factory Update (`packages/core/src/clients/factory.ts`)

Add `'opencode'` case to the switch statement:

```typescript
import { OpenCodeClient } from './opencode';

export function getAssistantClient(type: string): IAssistantClient {
  switch (type) {
    case 'claude':
      getLog().debug({ provider: 'claude' }, 'client_selected');
      return new ClaudeClient();
    case 'codex':
      getLog().debug({ provider: 'codex' }, 'client_selected');
      return new CodexClient();
    case 'opencode':
      getLog().debug({ provider: 'opencode' }, 'client_selected');
      return new OpenCodeClient();
    default:
      throw new Error(
        `Unknown assistant type: ${type}. Supported types: 'claude', 'codex', 'opencode'`
      );
  }
}
```

### Provider Type Expansion

The provider union `'claude' | 'codex'` expands to `'claude' | 'codex' | 'opencode'` in these locations:

**Zod schemas** (`packages/workflows/src/schemas/`):

```typescript
// workflow.ts — workflowBaseSchema
provider: z.enum(['claude', 'codex', 'opencode']).optional(),

// dag-node.ts — dagNodeBaseSchema
provider: z.enum(['claude', 'codex', 'opencode']).optional(),
```

**Workflow deps** (`packages/workflows/src/deps.ts`):

```typescript
// Provider type in WorkflowConfig, AssistantClientFactory, IWorkflowAssistantClient
export type AssistantClientFactory = (provider: 'claude' | 'codex' | 'opencode') => IWorkflowAssistantClient;

export interface WorkflowConfig {
  assistant: 'claude' | 'codex' | 'opencode';
  assistants: {
    claude: { ... };
    codex: { ... };
    opencode: { model?: string };
  };
}
```

**Config types** (`packages/core/src/config/config-types.ts`):

```typescript
// GlobalConfig
defaultAssistant?: 'claude' | 'codex' | 'opencode';

// RepoConfig
assistant?: 'claude' | 'codex' | 'opencode';

// MergedConfig
assistant: 'claude' | 'codex' | 'opencode';
assistants: {
  claude: ClaudeAssistantDefaults;
  codex: AssistantDefaults;
  opencode: AssistantDefaults;
};

// SafeConfig
assistants: {
  claude: Pick<ClaudeAssistantDefaults, 'model'>;
  codex: Pick<AssistantDefaults, 'model' | 'modelReasoningEffort' | 'webSearchMode'>;
  opencode: Pick<AssistantDefaults, 'model'>;
};
```

### Config Loader Updates (`packages/core/src/config/config-loader.ts`)

**Defaults** — add `opencode: {}` to `getDefaults()`:

```typescript
assistants: {
  claude: {},
  codex: {},
  opencode: {},
},
```

**Environment override** — accept `'opencode'` in `applyEnvOverrides()`:

```typescript
if (envAssistant === 'claude' || envAssistant === 'codex' || envAssistant === 'opencode') {
  config.assistant = envAssistant;
}
```

**Global merge** — merge `assistants.opencode` in `mergeGlobalConfig()`:

```typescript
if (global.assistants?.opencode) {
  result.assistants.opencode = { ...result.assistants.opencode, ...global.assistants.opencode };
}
```

**Repo merge** — merge `assistants.opencode` in `mergeRepoConfig()`:

```typescript
if (repo.assistants?.opencode) {
  result.assistants.opencode = { ...result.assistants.opencode, ...repo.assistants.opencode };
}
```

**Safe config** — project `opencode` in `toSafeConfig()`:

```typescript
opencode: { model: config.assistants.opencode.model },
```

### Model Validation Updates (`packages/workflows/src/model-validation.ts`)

opencode follows the same rule as Codex: accept any model that is not a Claude-specific alias.

```typescript
export function isModelCompatible(
  provider: 'claude' | 'codex' | 'opencode',
  model?: string
): boolean {
  if (!model) return true;
  if (provider === 'claude') return isClaudeModel(model);
  // Codex and opencode: accept most models, reject Claude aliases
  return !isClaudeModel(model);
}
```

The function signature changes from `provider: 'claude' | 'codex'` to `provider: 'claude' | 'codex' | 'opencode'`. The logic for opencode is identical to Codex — reject Claude-specific aliases (`sonnet`, `opus`, `haiku`, `inherit`, `claude-*`).

**No auto-inference for opencode**: When a workflow sets `model:` without `provider:` and the model is not a Claude alias, the executor infers `'codex'` (existing behavior). opencode is never auto-inferred — it must be explicitly set via `provider: opencode`.

### DAG Executor Updates (`packages/workflows/src/dag-executor.ts`)

**`resolveNodeProviderAndModel()`** — expand provider type and add opencode option building:

```typescript
async function resolveNodeProviderAndModel(
  node: DagNode,
  workflowProvider: 'claude' | 'codex' | 'opencode',
  ...
): Promise<{
  provider: 'claude' | 'codex' | 'opencode';
  model: string | undefined;
  options: WorkflowAssistantOptions | undefined;
}> {
  let provider: 'claude' | 'codex' | 'opencode';

  if (node.provider) {
    provider = node.provider;
  } else if (node.model && isClaudeModel(node.model)) {
    provider = 'claude';
  } else if (node.model) {
    // Non-Claude model without explicit provider → fall back to workflow default
    // (NOT inferred as opencode — only Claude is auto-inferred)
    provider = workflowProvider;
  } else {
    provider = workflowProvider;
  }

  // ... model resolution ...

  // Build options for opencode (similar to Codex — minimal options)
  if (provider === 'opencode') {
    options = { model };
    if (node.output_format) {
      options.outputFormat = { type: 'json_schema', schema: node.output_format };
    }

    // Warn on Claude-only options (same pattern as Codex warnings)
    // Warn on allowed_tools/denied_tools (not supported)
    // Warn on hooks, mcp, skills (not supported)
  }
}
```

**Warning pattern for opencode** mirrors the existing Codex warnings:

- `allowed_tools` / `denied_tools` → warn, ignore
- `hooks` → warn, ignore
- `mcp` → warn, ignore
- `skills` → warn, ignore
- Claude-only SDK options (`effort`, `thinking`, `maxBudgetUsd`, `systemPrompt`, `fallbackModel`, `betas`, `sandbox`) → warn, ignore

**Executor provider resolution** (`packages/workflows/src/executor.ts`) — expand the provider inference logic:

```typescript
// Existing: model inference only applies to Claude
if (workflow.model && isClaudeModel(workflow.model)) {
  resolvedProvider = 'claude';
} else if (workflow.model) {
  // Non-Claude model → still falls back to codex (not opencode)
  resolvedProvider = 'codex';
}
```

This is unchanged — opencode must be explicitly selected via `provider: opencode`.

## Data Models

### Config YAML Structure

```yaml
# ~/.archon/config.yaml
defaultAssistant: opencode # or 'claude' | 'codex'

assistants:
  claude:
    model: sonnet
  codex:
    model: gpt-5.3-codex
    modelReasoningEffort: medium
  opencode:
    model: anthropic/claude-sonnet-4-20250514 # opencode uses provider/model format
```

### Workflow YAML

```yaml
name: my-workflow
description: Example with opencode
provider: opencode
model: anthropic/claude-sonnet-4-20250514

nodes:
  - id: analyze
    prompt: 'Analyze the codebase'
    provider: opencode # per-node override
```

### Type Changes Summary

| File                  | Change                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config-types.ts`     | `GlobalConfig.defaultAssistant`, `RepoConfig.assistant`, `MergedConfig.assistant` → add `'opencode'`; `MergedConfig.assistants` → add `opencode: AssistantDefaults`; `SafeConfig.assistants` → add `opencode` |
| `deps.ts`             | `WorkflowConfig.assistant` → add `'opencode'`; `WorkflowConfig.assistants` → add `opencode`; `AssistantClientFactory` param → add `'opencode'`                                                                |
| `workflow.ts`         | `workflowBaseSchema.provider` enum → add `'opencode'`                                                                                                                                                         |
| `dag-node.ts`         | `dagNodeBaseSchema.provider` enum → add `'opencode'`                                                                                                                                                          |
| `model-validation.ts` | `isModelCompatible` param type → add `'opencode'`                                                                                                                                                             |
| `dag-executor.ts`     | Provider type in `resolveNodeProviderAndModel` → add `'opencode'`; add opencode option building branch                                                                                                        |
| `executor.ts`         | Provider type in `resolvedProvider` → add `'opencode'`                                                                                                                                                        |
| `config-loader.ts`    | `getDefaults()`, `mergeGlobalConfig()`, `mergeRepoConfig()`, `applyEnvOverrides()`, `toSafeConfig()` → handle opencode                                                                                        |
| `factory.ts`          | Add `'opencode'` case                                                                                                                                                                                         |

## Correctness Properties

_A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees._

### Property 1: SDK event-to-MessageChunk mapping preserves type correspondence

_For any_ sequence of mock opencode SDK response parts (text, tool-invocation, tool-result, thinking, completion), the `OpenCodeClient.sendQuery()` generator SHALL yield `MessageChunk` values where each chunk's `type` field corresponds to the SDK part type: text → `'assistant'`, tool-invocation → `'tool'`, tool-result → `'tool_result'`, thinking → `'thinking'`, completion → `'result'`.

**Validates: Requirements 1.1, 1.2**

### Property 2: Error classification consistency

_For any_ error message string, the opencode error classifier SHALL return `'rate_limit'` if the message contains rate-limit patterns, `'auth'` if it contains authentication patterns, `'crash'` if it contains subprocess crash patterns, and `'unknown'` otherwise. Auth-classified errors SHALL never be retried, and rate-limit/crash-classified errors SHALL be retried up to the maximum retry count.

**Validates: Requirements 1.4**

### Property 3: Unknown provider rejection

_For any_ string that is not `'claude'`, `'codex'`, or `'opencode'`, calling `getAssistantClient()` with that string SHALL throw an error whose message contains all three supported provider names.

**Validates: Requirements 2.2**

### Property 4: Config merge preserves opencode values

_For any_ valid opencode assistant config section (containing a random non-empty model string), merging it via `mergeGlobalConfig()` or `mergeRepoConfig()` SHALL produce a `MergedConfig` where `assistants.opencode.model` equals the input model string. The merge SHALL not alter `assistants.claude` or `assistants.codex` values.

**Validates: Requirements 4.1, 4.2**

### Property 5: Model validation for opencode rejects Claude aliases

_For any_ model string, `isModelCompatible('opencode', model)` SHALL return `false` if and only if the model matches a Claude-specific alias (`sonnet`, `opus`, `haiku`, `inherit`, or starts with `claude-`). For all other non-empty model strings, it SHALL return `true`.

**Validates: Requirements 5.1, 5.2, 5.4**

### Property 6: DAG executor option building from config

_For any_ valid `WorkflowConfig` with a non-empty `assistants.opencode.model` value, when `resolveNodeProviderAndModel()` resolves a node with `provider: 'opencode'` and no node-level model override, the returned `options.model` SHALL equal `config.assistants.opencode.model`.

**Validates: Requirements 6.3**

## Error Handling

### OpenCodeClient Errors

| Error Category | Pattern                                                         | Behavior                                         |
| -------------- | --------------------------------------------------------------- | ------------------------------------------------ |
| Rate limit     | `rate limit`, `429`, `too many requests`, `overloaded`          | Retry with exponential backoff (up to 3 retries) |
| Auth           | `unauthorized`, `401`, `403`, `invalid token`, `authentication` | Throw immediately (never retry)                  |
| Server crash   | `ECONNREFUSED`, `exited with code`, `killed`, `signal`          | Retry with exponential backoff                   |
| Abort          | `abortSignal.aborted`                                           | Throw `'Query aborted'` immediately              |
| Unknown        | Everything else                                                 | Throw after enriching with context               |

### Server Lifecycle

The `OpenCodeClient` manages the opencode server lifecycle:

- **Startup**: `createOpencode()` starts a local server if none is running. The client stores the server reference for cleanup.
- **Connection failure**: If the server fails to start within the timeout (default 5s), throw a FATAL error.
- **Graceful shutdown**: Call `server.close()` when the client is no longer needed. The DAG executor does not manage server lifecycle — the client handles it internally per-query.

### Config Errors

- Invalid `provider: opencode` with Claude model → rejected at workflow load time by `isModelCompatible()`
- Missing opencode SDK (`@opencode-ai/sdk` not installed) → import error at factory instantiation time, surfaced as a clear error message
- Invalid `assistants.opencode` config values → ignored with defaults (consistent with existing config behavior)

## Testing Strategy

### Test Structure

Tests follow the existing `mock.module()` isolation pattern. The `OpenCodeClient` tests must run in a separate `bun test` invocation to avoid mock pollution.

**New test files:**

- `packages/core/src/clients/opencode.test.ts` — OpenCodeClient unit tests (mock `@opencode-ai/sdk`)
- `packages/core/src/clients/factory.test.ts` — updated to cover `'opencode'` case (existing file)

**Updated test files:**

- `packages/workflows/src/model-validation.test.ts` — add opencode provider cases
- `packages/core/src/config/config-loader.test.ts` — add opencode config merge tests
- `packages/workflows/src/dag-executor.test.ts` — add opencode provider resolution tests
- `packages/workflows/src/loader.test.ts` — add opencode schema validation tests

### Mock Pattern for OpenCodeClient

```typescript
// opencode.test.ts — mock the SDK before importing the client
const mockClient = {
  session: {
    create: mock(() => Promise.resolve({ data: { id: 'test-session' } })),
    prompt: mock(() => Promise.resolve({ data: { info: { ... }, parts: [...] } })),
    get: mock(() => Promise.resolve({ data: { id: 'test-session' } })),
  },
  event: {
    subscribe: mock(() => Promise.resolve({ stream: mockEventStream() })),
  },
};
const mockServer = { url: 'http://localhost:4096', close: mock(() => {}) };

mock.module('@opencode-ai/sdk', () => ({
  createOpencode: mock(() => Promise.resolve({ client: mockClient, server: mockServer })),
  createOpencodeClient: mock(() => mockClient),
}));

// Import AFTER mock
import { OpenCodeClient } from './opencode';
```

### Dual Testing Approach

**Unit tests** (example-based):

- Factory returns `OpenCodeClient` for `'opencode'`
- Factory error message lists all three providers
- Config merge with opencode section
- Schema accepts `provider: 'opencode'`
- DAG executor warns on Claude-only options for opencode nodes
- Model validation rejects Claude aliases for opencode

**Property tests** (property-based, minimum 100 iterations each):

- **Feature: opencode-agent-provider, Property 1**: SDK event mapping
- **Feature: opencode-agent-provider, Property 2**: Error classification
- **Feature: opencode-agent-provider, Property 3**: Unknown provider rejection
- **Feature: opencode-agent-provider, Property 4**: Config merge preservation
- **Feature: opencode-agent-provider, Property 5**: Model validation
- **Feature: opencode-agent-provider, Property 6**: Option building from config

**Property-based testing library**: `fast-check` (already compatible with Bun test runner, generates arbitrary strings/objects for input fuzzing).

**Test batch configuration**: Add `opencode.test.ts` as a separate `bun test` invocation in `packages/core/package.json` test script to avoid `mock.module()` pollution with existing client tests.
