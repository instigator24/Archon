---
inclusion: fileMatch
fileMatchPattern: 'packages/workflows/**/*.ts,.archon/workflows/**/*.yaml,.archon/commands/**/*.md'
---

# Workflows Conventions

## DAG Workflow Format

All workflows use DAG format with `nodes:`. Loop nodes supported as a node type within DAGs.

```yaml
nodes:
  - id: classify
    prompt: 'Classify this issue'
    output_format: { type: object, properties: { type: { type: string } } }
  - id: implement
    command: execute
    depends_on: [classify]
    when: "$classify.output.type == 'FEATURE'"
  - id: lint
    bash: 'bun run lint'
    depends_on: [implement]
```

## DAG Node Types

- `command:` — named file from `.archon/commands/`, AI-executed
- `prompt:` — inline prompt string, AI-executed
- `bash:` — shell script, no AI; stdout captured as `$nodeId.output`; default timeout 120000ms
- `loop:` — iterative AI prompt until completion signal

## Variable Substitution

`$1`-`$9` (positional), `$ARGUMENTS`, `$ARTIFACTS_DIR`, `$WORKFLOW_ID`, `$BASE_BRANCH`, `$DOCS_DIR`, `$nodeId.output` (DAG output references), `$LOOP_USER_INPUT`, `$REJECTION_REASON`.

## WorkflowDeps — Dependency Injection

`@archon/workflows` has ZERO `@archon/core` dependency. Everything injected via `WorkflowDeps`: `store` (IWorkflowStore), `getAssistantClient` (factory), `loadConfig`. Core creates the adapter via `createWorkflowDeps()`.

## Trigger Rules

`all_success` (default), `one_success`, `none_failed_min_one_success`, `all_done`.

## `when:` Conditions

Pattern: `$nodeId.output[.field] OPERATOR 'value'`. Operators: `==` and `!=` only. Unparseable → `false` (node skipped).

## Model Validation

Runs at load time. Claude models: `sonnet`, `opus`, `haiku`, `inherit`, `claude-*`. Codex: anything not matching Claude patterns. Invalid combos fail loading.

## Anti-patterns

- Never import `@archon/core` from `@archon/workflows` (circular dependency)
- Never add `clearContext: true` to every step — context continuity is valuable
- Never put `output_format` on Codex nodes (ignored with warning)
- Never set `allowed_tools: undefined` expecting "no tools" — use `allowed_tools: []`
