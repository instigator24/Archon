# Implementation Plan: OpenCode Agent Provider

## Overview

Add opencode as a third AI agent provider alongside Claude and Codex. Implementation follows the existing provider pattern: expand provider type unions across Zod schemas and TypeScript types, update config types and loader, extend model validation, implement the OpenCodeClient, register it in the client factory, and update the DAG executor for opencode provider resolution and option building.

## Tasks

- [x] 1. Expand provider type across Zod schemas and TypeScript types
  - [x] 1.1 Add `'opencode'` to the provider enum in `packages/workflows/src/schemas/dag-node.ts` (`dagNodeBaseSchema.provider`)
    - Change `z.enum(['claude', 'codex'])` to `z.enum(['claude', 'codex', 'opencode'])`
    - _Requirements: 3.2_

  - [x] 1.2 Add `'opencode'` to the provider enum in `packages/workflows/src/schemas/workflow.ts` (`workflowBaseSchema.provider`)
    - Change `z.enum(['claude', 'codex'])` to `z.enum(['claude', 'codex', 'opencode'])`
    - _Requirements: 3.1_

  - [x] 1.3 Update `AssistantClientFactory` type and `WorkflowConfig` in `packages/workflows/src/deps.ts`
    - Expand `AssistantClientFactory` parameter from `'claude' | 'codex'` to `'claude' | 'codex' | 'opencode'`
    - Expand `WorkflowConfig.assistant` from `'claude' | 'codex'` to `'claude' | 'codex' | 'opencode'`
    - Add `opencode: { model?: string }` to `WorkflowConfig.assistants`
    - _Requirements: 3.3, 3.4, 4.5_

  - [x] 1.4 Update config types in `packages/core/src/config/config-types.ts`
    - Expand `GlobalConfig.defaultAssistant` to include `'opencode'`
    - Expand `RepoConfig.assistant` to include `'opencode'`
    - Expand `MergedConfig.assistant` to include `'opencode'`
    - Add `opencode: AssistantDefaults` to `MergedConfig.assistants`
    - Expand `SafeConfig.assistant` to include `'opencode'`
    - Add `opencode: Pick<AssistantDefaults, 'model'>` to `SafeConfig.assistants`
    - _Requirements: 3.5, 3.6, 4.1, 4.6_

- [x] 2. Update config loader for opencode support
  - [x] 2.1 Update `packages/core/src/config/config-loader.ts`
    - Add `opencode: {}` to `getDefaults()` assistants
    - Accept `'opencode'` in `applyEnvOverrides()` for `DEFAULT_AI_ASSISTANT` env var
    - Merge `assistants.opencode` in `mergeGlobalConfig()`
    - Merge `assistants.opencode` in `mergeRepoConfig()`
    - Project `opencode` in `toSafeConfig()`
    - Update `updateGlobalConfig()` to merge opencode assistants
    - _Requirements: 4.2, 4.3, 4.4_

  - [x] 2.2 Write unit tests for opencode config merging in `packages/core/src/config/config-loader.test.ts`
    - Test `getDefaults()` includes `assistants.opencode`
    - Test global config merge with `assistants.opencode.model`
    - Test repo config merge with `assistants.opencode`
    - Test `DEFAULT_AI_ASSISTANT=opencode` env override
    - Test `toSafeConfig()` includes opencode section
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.6_

  - [x] 2.3 Write property test for config merge preservation (Property 4)
    - **Property 4: Config merge preserves opencode values**
    - For any valid opencode config section with a random non-empty model string, merging via `mergeGlobalConfig()` or `mergeRepoConfig()` produces a `MergedConfig` where `assistants.opencode.model` equals the input. The merge does not alter `assistants.claude` or `assistants.codex`.
    - Use `fast-check` with arbitrary string generation
    - **Validates: Requirements 4.1, 4.2**

- [x] 3. Update model validation for opencode provider
  - [x] 3.1 Update `packages/workflows/src/model-validation.ts`
    - Expand `isModelCompatible()` parameter type from `'claude' | 'codex'` to `'claude' | 'codex' | 'opencode'`
    - opencode uses the same validation logic as Codex: reject Claude-specific aliases
    - _Requirements: 5.1, 5.2_

  - [x] 3.2 Write unit tests for opencode model validation in `packages/workflows/src/model-validation.test.ts`
    - Test `isModelCompatible('opencode', 'some-model')` returns `true`
    - Test `isModelCompatible('opencode', 'sonnet')` returns `false`
    - Test `isModelCompatible('opencode', 'claude-3-opus')` returns `false`
    - Test `isModelCompatible('opencode', undefined)` returns `true`
    - _Requirements: 5.1, 5.2, 5.4_

  - [x] 3.3 Write property test for opencode model validation (Property 5)
    - **Property 5: Model validation for opencode rejects Claude aliases**
    - For any model string, `isModelCompatible('opencode', model)` returns `false` iff the model matches a Claude alias (`sonnet`, `opus`, `haiku`, `inherit`, or starts with `claude-`). For all other non-empty strings, returns `true`.
    - Use `fast-check` with arbitrary string generation
    - **Validates: Requirements 5.1, 5.2, 5.4**

- [x] 4. Checkpoint — Ensure type changes compile
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement OpenCodeClient
  - [x] 5.1 Create `packages/core/src/clients/opencode.ts`
    - Implement `IAssistantClient` interface with `sendQuery()` and `getType()`
    - Use lazy-initialized logger pattern (`getLog()` with `createLogger('client.opencode')`)
    - Implement SDK interaction: `createOpencode()` → session create/resume → prompt → SSE event streaming
    - Map SDK events to `MessageChunk` types (text→assistant, tool-invocation→tool, tool-result→tool_result, thinking→thinking, completion→result)
    - Implement error classification (rate_limit, auth, crash, unknown) matching Claude/Codex patterns
    - Implement retry logic with exponential backoff (up to 3 retries for transient errors)
    - Implement pre-spawn env-leak check (same pattern as Claude/Codex)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 8.2_

  - [x] 5.2 Write unit tests for OpenCodeClient in `packages/core/src/clients/opencode.test.ts`
    - Mock `@opencode-ai/sdk` before importing client (follow mock.module pattern)
    - Test `getType()` returns `'opencode'`
    - Test `sendQuery()` yields correct `MessageChunk` types for each SDK event
    - Test error classification and retry behavior
    - Test abort signal handling
    - Add as a separate `bun test` invocation in `packages/core/package.json` test script
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 5.3 Write property test for SDK event-to-MessageChunk mapping (Property 1)
    - **Property 1: SDK event-to-MessageChunk mapping preserves type correspondence**
    - For any sequence of mock SDK response parts (text, tool-invocation, tool-result, thinking, completion), `sendQuery()` yields `MessageChunk` values where each chunk's type corresponds to the SDK part type.
    - Use `fast-check` with arbitrary event sequence generation
    - **Validates: Requirements 1.1, 1.2**

  - [x] 5.4 Write property test for error classification consistency (Property 2)
    - **Property 2: Error classification consistency**
    - For any error message string, the classifier returns `'rate_limit'` for rate-limit patterns, `'auth'` for auth patterns, `'crash'` for crash patterns, and `'unknown'` otherwise. Auth errors are never retried.
    - Use `fast-check` with arbitrary string generation
    - **Validates: Requirements 1.4**

- [x] 6. Register OpenCodeClient in client factory
  - [x] 6.1 Update `packages/core/src/clients/factory.ts`
    - Import `OpenCodeClient` from `./opencode`
    - Add `case 'opencode'` to the switch statement returning `new OpenCodeClient()`
    - Log debug message with `provider: 'opencode'`
    - Update error message to list all three supported types: `'claude', 'codex', 'opencode'`
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 6.2 Write unit tests for factory opencode case
    - Test `getAssistantClient('opencode')` returns an `OpenCodeClient` instance
    - Test unknown type error message lists all three providers
    - Can be added to existing client test batch (`bun test src/clients/`)
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 6.3 Write property test for unknown provider rejection (Property 3)
    - **Property 3: Unknown provider rejection**
    - For any string that is not `'claude'`, `'codex'`, or `'opencode'`, `getAssistantClient()` throws an error whose message contains all three supported provider names.
    - Use `fast-check` with arbitrary string generation filtered to exclude valid providers
    - **Validates: Requirements 2.2**

- [x] 7. Update DAG executor and executor for opencode provider resolution
  - [x] 7.1 Update `resolveNodeProviderAndModel()` in `packages/workflows/src/dag-executor.ts`
    - Expand provider type from `'claude' | 'codex'` to `'claude' | 'codex' | 'opencode'`
    - Add opencode option building branch (minimal: `model` + `outputFormat`)
    - Add warnings for Claude-only options on opencode nodes (hooks, mcp, skills, effort, thinking, maxBudgetUsd, systemPrompt, fallbackModel, betas, sandbox)
    - Add warnings for `allowed_tools`/`denied_tools` on opencode nodes
    - Use `config.assistants.opencode?.model` for default model when provider is opencode
    - _Requirements: 6.1, 6.3, 6.4, 6.5_

  - [x] 7.2 Update `executeWorkflow()` in `packages/workflows/src/executor.ts`
    - Expand `resolvedProvider` type from `'claude' | 'codex'` to `'claude' | 'codex' | 'opencode'`
    - Accept `provider: 'opencode'` from workflow definition
    - Non-Claude model without explicit provider still falls back to `'codex'` (not opencode) — opencode must be explicit
    - _Requirements: 6.2, 7.1, 7.2_

  - [x] 7.3 Update workflow loader in `packages/workflows/src/loader.ts`
    - Accept `'opencode'` in the provider parsing logic (the `raw.provider` check)
    - _Requirements: 7.1, 7.2, 7.3_

  - [x] 7.4 Write unit tests for opencode DAG executor behavior in `packages/workflows/src/dag-executor.test.ts`
    - Test node with `provider: 'opencode'` uses opencode client
    - Test workflow-level `provider: 'opencode'` propagates to nodes
    - Test Claude-only options on opencode node produce warnings
    - Test `allowed_tools`/`denied_tools` on opencode node produce warnings
    - _Requirements: 6.1, 6.2, 6.4, 6.5_

  - [x] 7.5 Write unit tests for opencode in workflow loader in `packages/workflows/src/loader.test.ts`
    - Test workflow YAML with `provider: opencode` parses successfully
    - Test DAG node with `provider: opencode` parses successfully
    - Test `provider: opencode` with Claude model fails validation
    - _Requirements: 7.1, 7.2, 5.4_

  - [x] 7.6 Write property test for DAG executor option building from config (Property 6)
    - **Property 6: DAG executor option building from config**
    - For any valid `WorkflowConfig` with a non-empty `assistants.opencode.model`, when resolving a node with `provider: 'opencode'` and no node-level model override, the returned `options.model` equals `config.assistants.opencode.model`.
    - Use `fast-check` with arbitrary config generation
    - **Validates: Requirements 6.3**

- [x] 8. Update test batch configuration
  - [x] 8.1 Update `packages/core/package.json` test script
    - Add `opencode.test.ts` as a separate `bun test` invocation to avoid `mock.module()` pollution
    - Ensure it runs in isolation from existing client tests
    - _Requirements: 1.6_

- [x] 9. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The design uses TypeScript throughout — no language selection needed
- opencode must always be explicitly selected via `provider: opencode` — it is never auto-inferred from model names
