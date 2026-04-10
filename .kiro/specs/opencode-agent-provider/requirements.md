# Requirements Document

## Introduction

Add opencode as a third AI agent provider in Archon alongside Claude and Codex. This enables users to run workflows using opencode agents in isolated worktrees, configure opencode-specific options in `.archon/config.yaml`, and set opencode as the default provider or use it per-workflow/per-node. The implementation follows the existing provider pattern: an `IAssistantClient` implementation in `@archon/core`, wired through the client factory, with provider type propagated through schemas, config, model validation, and the DAG executor.

## Glossary

- **Archon**: The remote agentic coding platform that orchestrates AI coding assistants
- **Provider**: An AI assistant backend identified by a string literal (`'claude'`, `'codex'`, or `'opencode'`); selectable at config, workflow, or node level
- **IAssistantClient**: The interface in `packages/core/src/types/index.ts` that all provider clients implement (`sendQuery()`, `getType()`)
- **Client_Factory**: The function `getAssistantClient()` in `packages/core/src/clients/factory.ts` that maps a provider string to an `IAssistantClient` instance
- **WorkflowDeps**: The dependency injection type in `packages/workflows/src/deps.ts` that provides `getAssistantClient` factory to the workflow engine
- **DAG_Executor**: The workflow execution engine in `packages/workflows/src/dag-executor.ts` that resolves per-node provider/model and builds provider-specific options
- **Model_Validation**: The module `packages/workflows/src/model-validation.ts` that validates provider/model compatibility at workflow load time
- **Provider_Type**: The union type `'claude' | 'codex' | 'opencode'` used across schemas, config types, and executor logic
- **MergedConfig**: The fully resolved configuration object combining global, repo, and env overrides
- **OpenCode_Client**: The new `IAssistantClient` implementation for the opencode provider
- **MessageChunk**: The discriminated union type representing streaming response chunks from AI assistants

## Requirements

### Requirement 1: OpenCode Client Implementation

**User Story:** As a developer, I want an opencode client that implements the IAssistantClient interface, so that Archon can send queries to opencode agents and stream responses.

#### Acceptance Criteria

1. THE OpenCode_Client SHALL implement the `IAssistantClient` interface with `sendQuery()` returning `AsyncGenerator<MessageChunk>` and `getType()` returning `'opencode'`
2. WHEN `sendQuery()` is called with a prompt, cwd, optional resumeSessionId, and optional options, THE OpenCode_Client SHALL invoke the opencode SDK and yield `MessageChunk` values for assistant text, tool calls, tool results, thinking, and result events
3. WHEN the opencode SDK emits a session completion event, THE OpenCode_Client SHALL yield a `MessageChunk` of type `'result'` containing sessionId, token usage, cost, and stop reason
4. IF the opencode SDK returns an error, THEN THE OpenCode_Client SHALL classify the error as TRANSIENT or FATAL using the same classification patterns as existing clients and propagate it appropriately
5. THE OpenCode_Client SHALL follow the lazy-initialized logger pattern (`getLog()`) consistent with `ClaudeClient` and `CodexClient`
6. THE OpenCode_Client SHALL reside at `packages/core/src/clients/opencode.ts` following the existing file layout convention

### Requirement 2: Client Factory Registration

**User Story:** As a developer, I want the client factory to recognize `'opencode'` as a valid provider type, so that the workflow engine can instantiate opencode clients.

#### Acceptance Criteria

1. WHEN `getAssistantClient('opencode')` is called, THE Client_Factory SHALL return a new `OpenCode_Client` instance
2. WHEN `getAssistantClient()` is called with an unknown type that is not `'claude'`, `'codex'`, or `'opencode'`, THE Client_Factory SHALL throw an error listing all three supported types
3. THE Client_Factory SHALL log a debug message with `provider: 'opencode'` when the opencode client is selected

### Requirement 3: Provider Type Expansion

**User Story:** As a developer, I want the provider type union to include `'opencode'` across all schemas and type definitions, so that opencode can be selected at any level.

#### Acceptance Criteria

1. THE Provider_Type in `packages/workflows/src/schemas/workflow.ts` (`workflowBaseSchema.provider`) SHALL accept `'opencode'` as a valid enum value
2. THE Provider_Type in `packages/workflows/src/schemas/dag-node.ts` (`dagNodeBaseSchema.provider`) SHALL accept `'opencode'` as a valid enum value
3. THE `WorkflowConfig.assistant` type in `packages/workflows/src/deps.ts` SHALL accept `'opencode'`
4. THE `AssistantClientFactory` type in `packages/workflows/src/deps.ts` SHALL accept `'opencode'` as a parameter
5. THE `MergedConfig.assistant` type in `packages/core/src/config/config-types.ts` SHALL accept `'opencode'`
6. THE `GlobalConfig.defaultAssistant` and `RepoConfig.assistant` types SHALL accept `'opencode'`

### Requirement 4: Configuration Support

**User Story:** As a user, I want to configure opencode-specific defaults in `.archon/config.yaml`, so that I can set model preferences and provider-specific options for opencode.

#### Acceptance Criteria

1. THE MergedConfig SHALL include an `assistants.opencode` section with at minimum a `model` field
2. WHEN `.archon/config.yaml` contains an `assistants.opencode` section, THE config loader SHALL merge opencode defaults into `MergedConfig.assistants.opencode`
3. WHEN `defaultAssistant: opencode` is set in global or repo config, THE config loader SHALL set `MergedConfig.assistant` to `'opencode'`
4. WHEN the environment variable `DEFAULT_AI_ASSISTANT` is set to `'opencode'`, THE config loader SHALL override the assistant to `'opencode'`
5. THE `WorkflowConfig.assistants` in `packages/workflows/src/deps.ts` SHALL include an `opencode` section matching the config structure
6. THE `SafeConfig.assistants` SHALL include an `opencode` section so the Web UI can display opencode configuration

### Requirement 5: Model Validation

**User Story:** As a developer, I want model validation to handle opencode models correctly, so that invalid provider/model combinations are caught at workflow load time.

#### Acceptance Criteria

1. THE Model_Validation module SHALL accept `'opencode'` as a valid provider in `isModelCompatible()`
2. WHEN provider is `'opencode'` and a model string is provided, THE Model_Validation module SHALL validate the model is compatible with opencode (rejecting Claude-specific aliases like `sonnet`, `opus`, `haiku`, `inherit`, and `claude-*` prefixes)
3. WHEN a workflow sets `model:` without `provider:` and the model is not a Claude alias, THE executor SHALL NOT automatically infer `'opencode'` — it SHALL fall back to config default (inference is only for Claude models)
4. IF a workflow specifies `provider: opencode` with a Claude-specific model, THEN THE Model_Validation module SHALL reject the combination with a clear error message

### Requirement 6: DAG Executor Provider Resolution

**User Story:** As a developer, I want the DAG executor to correctly resolve opencode as a provider and build appropriate options, so that opencode nodes execute with the right configuration.

#### Acceptance Criteria

1. WHEN a DAG node specifies `provider: opencode`, THE DAG_Executor SHALL use the opencode provider for that node
2. WHEN the workflow-level provider is `'opencode'`, THE DAG_Executor SHALL use opencode for all nodes that do not override the provider
3. THE DAG_Executor SHALL build `WorkflowAssistantOptions` for opencode nodes using the `assistants.opencode` config section for defaults
4. WHEN an opencode node specifies Claude-only options (hooks, mcp, skills, effort, thinking, maxBudgetUsd, systemPrompt, fallbackModel, betas, sandbox), THE DAG_Executor SHALL log a warning and notify the user that these options are ignored for opencode
5. WHEN an opencode node specifies `allowed_tools` or `denied_tools`, THE DAG_Executor SHALL log a warning that per-node tool restrictions are not supported for opencode

### Requirement 7: Workflow YAML Provider Selection

**User Story:** As a user, I want to set `provider: opencode` in my workflow YAML files at both the workflow level and per-node level, so that I can use opencode agents in my workflows.

#### Acceptance Criteria

1. WHEN a workflow YAML file contains `provider: opencode` at the top level, THE workflow loader SHALL parse and accept the provider value
2. WHEN a DAG node in a workflow YAML file contains `provider: opencode`, THE workflow loader SHALL parse and accept the provider value
3. WHEN a workflow YAML file contains an unrecognized provider value, THE workflow loader SHALL ignore it and fall back to the config default (consistent with existing behavior)

### Requirement 8: Isolated Worktree Execution

**User Story:** As a user, I want opencode agents to run in isolated git worktrees, so that parallel development is safe and consistent with Claude/Codex behavior.

#### Acceptance Criteria

1. WHEN a workflow using the opencode provider is executed with isolation enabled, THE system SHALL create a git worktree and pass the worktree path as `cwd` to `OpenCode_Client.sendQuery()`
2. THE OpenCode_Client SHALL execute the opencode SDK subprocess within the provided `cwd` directory
3. WHEN the workflow completes or fails, THE system SHALL clean up the worktree using the same lifecycle as Claude and Codex workflows
