/**
 * OpenCode SDK wrapper
 * Provides async generator interface for streaming OpenCode responses
 *
 * Uses the @opencode-ai/sdk client-server architecture: the SDK starts
 * (or connects to) a local HTTP server and communicates via REST + SSE.
 */
import { createOpencode } from '@opencode-ai/sdk';
import type { Event as OpenCodeEvent, Part, AssistantMessage } from '@opencode-ai/sdk';
import type { AssistantRequestOptions, IAssistantClient, MessageChunk, TokenUsage } from '../types';
import { createLogger } from '@archon/paths';
import { scanPathForSensitiveKeys, EnvLeakError } from '../utils/env-leak-scanner';
import * as codebaseDb from '../db/codebases';
import { loadConfig } from '../config/config-loader';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('client.opencode');
  return cachedLog;
}

/** Max retries for transient failures (3 = 4 total attempts).
 *  Mirrors ClaudeClient/CodexClient retry logic. */
const MAX_RETRIES = 3;

/** Delay between retries in milliseconds */
const RETRY_BASE_DELAY_MS = 2000;

/** Patterns indicating rate limiting in error messages */
const RATE_LIMIT_PATTERNS = ['rate limit', 'too many requests', '429', 'overloaded'];

/** Patterns indicating auth issues in error messages */
const AUTH_PATTERNS = ['unauthorized', 'authentication', 'invalid token', '401', '403'];

/** Patterns indicating a transient crash (worth retrying) */
const CRASH_PATTERNS = ['exited with code', 'killed', 'signal', 'econnrefused'];

/**
 * Classify an opencode error message into a category.
 * Exported for independent testing.
 */
export function classifyOpenCodeError(
  errorMessage: string
): 'rate_limit' | 'auth' | 'crash' | 'unknown' {
  const m = errorMessage.toLowerCase();
  if (RATE_LIMIT_PATTERNS.some(p => m.includes(p))) return 'rate_limit';
  if (AUTH_PATTERNS.some(p => m.includes(p))) return 'auth';
  if (CRASH_PATTERNS.some(p => m.includes(p))) return 'crash';
  return 'unknown';
}

/**
 * Extract token usage from an AssistantMessage.
 */
function extractUsage(msg: AssistantMessage): TokenUsage {
  return {
    input: msg.tokens?.input ?? 0,
    output: msg.tokens?.output ?? 0,
  };
}

/**
 * Extract error message from an AssistantMessage error union.
 */
function extractErrorMessage(error: AssistantMessage['error']): string | undefined {
  if (!error) return undefined;
  switch (error.name) {
    case 'ProviderAuthError':
      return error.data.message;
    case 'UnknownError':
      return error.data.message;
    case 'MessageAbortedError':
      return error.data.message;
    case 'APIError':
      return error.data.message;
    case 'MessageOutputLengthError':
      return 'Message output length exceeded';
    default:
      return 'Unknown error';
  }
}

/**
 * OpenCode AI assistant client
 * Implements generic IAssistantClient interface
 */
export class OpenCodeClient implements IAssistantClient {
  private readonly retryBaseDelayMs: number;

  constructor(options?: { retryBaseDelayMs?: number }) {
    this.retryBaseDelayMs = options?.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
  }

  /**
   * Send a query to OpenCode and stream responses
   * @param prompt - User message or prompt
   * @param cwd - Working directory for OpenCode
   * @param resumeSessionId - Optional session ID to resume
   * @param options - Optional request options
   */
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: AssistantRequestOptions
  ): AsyncGenerator<MessageChunk> {
    // Pre-spawn: check for env key leak if codebase is not explicitly consented.
    // Use prefix lookup so worktree paths (e.g. .../worktrees/feature-branch) still
    // match the registered source cwd (e.g. .../source).
    const codebase =
      (await codebaseDb.findCodebaseByDefaultCwd(cwd)) ??
      (await codebaseDb.findCodebaseByPathPrefix(cwd));
    if (codebase && !codebase.allow_env_keys) {
      // Fail-closed: a config load failure must NOT silently bypass the gate.
      let allowTargetRepoKeys = false;
      try {
        const merged = await loadConfig(cwd);
        allowTargetRepoKeys = merged.allowTargetRepoKeys;
      } catch (configErr) {
        getLog().warn({ err: configErr, cwd }, 'env_leak_gate.config_load_failed_gate_enforced');
      }
      if (!allowTargetRepoKeys) {
        const report = scanPathForSensitiveKeys(cwd);
        if (report.findings.length > 0) {
          throw new EnvLeakError(report, 'spawn-existing');
        }
      }
    }

    // Check if already aborted before starting
    if (options?.abortSignal?.aborted) {
      throw new Error('Query aborted');
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Check abort signal before each attempt
      if (options?.abortSignal?.aborted) {
        throw new Error('Query aborted');
      }

      try {
        yield* this.executeQuery(prompt, cwd, resumeSessionId, options);
        return; // Success - exit retry loop
      } catch (error) {
        const err = error as Error;

        // Don't retry aborted queries
        if (options?.abortSignal?.aborted) {
          throw new Error('Query aborted');
        }

        const errorClass = classifyOpenCodeError(err.message);
        getLog().error({ err, errorClass, attempt, maxRetries: MAX_RETRIES }, 'query_error');

        // Auth errors won't resolve on retry
        if (errorClass === 'auth') {
          const enrichedError = new Error(`OpenCode auth error: ${err.message}`);
          enrichedError.cause = error;
          throw enrichedError;
        }

        // Retry transient failures (rate limit, crash)
        if (attempt < MAX_RETRIES && (errorClass === 'rate_limit' || errorClass === 'crash')) {
          const delayMs = this.retryBaseDelayMs * Math.pow(2, attempt);
          getLog().info({ attempt, delayMs, errorClass }, 'retrying_query');
          await new Promise(resolve => setTimeout(resolve, delayMs));
          lastError = err;
          continue;
        }

        // Final failure - enrich and throw
        const enrichedError = new Error(`OpenCode ${errorClass}: ${err.message}`);
        enrichedError.cause = error;
        throw enrichedError;
      }
    }

    // Should not reach here, but handle defensively
    throw lastError ?? new Error('OpenCode query failed after retries');
  }

  /**
   * Execute a single query attempt against the OpenCode SDK.
   * Separated from sendQuery to keep retry logic clean.
   */
  private async *executeQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: AssistantRequestOptions
  ): AsyncGenerator<MessageChunk> {
    // Start server + client (or connect to existing)
    const { client, server } = await createOpencode({
      config: { model: options?.model },
    });

    try {
      // Create or resume session
      let sessionId: string;
      if (resumeSessionId) {
        getLog().debug({ sessionId: resumeSessionId }, 'resuming_session');
        try {
          const session = await client.session.get({
            path: { id: resumeSessionId },
          });
          if (!session.data) {
            throw new Error(`Session not found: ${resumeSessionId}`);
          }
          sessionId = session.data.id;
        } catch (resumeErr) {
          getLog().error({ err: resumeErr, sessionId: resumeSessionId }, 'resume_session_failed');
          // Fall back to creating new session
          const session = await client.session.create({
            body: { title: 'archon-workflow' },
          });
          if (!session.data) {
            throw new Error('Failed to create opencode session');
          }
          sessionId = session.data.id;
          yield {
            type: 'system',
            content: '⚠️ Could not resume previous session. Starting fresh conversation.',
          };
        }
      } else {
        getLog().debug({ cwd }, 'starting_new_session');
        const session = await client.session.create({
          body: { title: 'archon-workflow' },
        });
        if (!session.data) {
          throw new Error('Failed to create opencode session');
        }
        sessionId = session.data.id;
      }

      // Send prompt
      const promptResult = await client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: 'text', text: prompt }],
        },
      });

      // Process the synchronous response parts first
      if (promptResult.data) {
        const { info, parts } = promptResult.data;
        yield* this.mapPartsToChunks(parts);

        // If the message completed with an error, surface it
        if (info.error) {
          const errorMsg = extractErrorMessage(info.error);
          if (errorMsg) {
            // Check if this is an auth error that should be thrown
            if (info.error.name === 'ProviderAuthError') {
              throw new Error(`unauthorized: ${errorMsg}`);
            }
            yield { type: 'system', content: `❌ ${errorMsg}` };
          }
        }
      }

      // Subscribe to SSE events for streaming updates
      const events = await client.event.subscribe();
      for await (const event of events.stream) {
        // Check abort signal between events
        if (options?.abortSignal?.aborted) {
          getLog().info('query_aborted_between_events');
          break;
        }

        const chunks = this.mapEventToChunks(event, sessionId);
        for (const chunk of chunks) {
          yield chunk;
        }

        // Break on session idle (indicates completion)
        const evt = event;
        if (evt.type === 'session.idle') {
          const idleProps = evt.properties as { sessionID?: string };
          if (idleProps.sessionID === sessionId) {
            break;
          }
        }

        // Break on session error
        if (evt.type === 'session.error') {
          const errorProps = evt.properties as {
            sessionID?: string;
            error?: AssistantMessage['error'];
          };
          if (!errorProps.sessionID || errorProps.sessionID === sessionId) {
            if (errorProps.error) {
              const errorMsg = extractErrorMessage(errorProps.error);
              if (errorMsg) {
                // Re-throw auth errors so retry logic can classify them
                if (errorProps.error.name === 'ProviderAuthError') {
                  throw new Error(`unauthorized: ${errorMsg}`);
                }
                // Re-throw API errors with status codes for classification
                if (errorProps.error.name === 'APIError' && errorProps.error.data.statusCode) {
                  throw new Error(`${errorProps.error.data.statusCode}: ${errorMsg}`);
                }
              }
            }
            break;
          }
        }
      }

      // Yield final result
      if (promptResult.data?.info) {
        const info = promptResult.data.info;
        const usage = extractUsage(info);
        yield {
          type: 'result',
          sessionId,
          tokens: usage,
          cost: info.cost,
        };
      }
    } finally {
      // Clean up server connection
      try {
        server.close();
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Map an array of SDK Part objects to MessageChunk values.
   */
  private *mapPartsToChunks(parts: Part[]): Generator<MessageChunk> {
    for (const part of parts) {
      switch (part.type) {
        case 'text':
          if (part.text) {
            yield { type: 'assistant', content: part.text };
          }
          break;

        case 'tool': {
          const toolName = part.tool ?? 'unknown';
          yield {
            type: 'tool',
            toolName,
            toolInput: part.state.input ?? {},
          };
          // If tool is completed or errored, also emit tool_result
          if (part.state.status === 'completed') {
            yield {
              type: 'tool_result',
              toolName,
              toolOutput: part.state.output ?? '',
            };
          } else if (part.state.status === 'error') {
            yield {
              type: 'tool_result',
              toolName,
              toolOutput: `❌ Error: ${part.state.error ?? 'unknown error'}`,
            };
          }
          break;
        }

        case 'reasoning':
          if (part.text) {
            yield { type: 'thinking', content: part.text };
          }
          break;

        case 'step-finish':
          // Step finish contains per-step token usage — log but don't yield
          getLog().debug({ reason: part.reason, cost: part.cost }, 'step_finished');
          break;

        // Other part types (file, snapshot, patch, agent, retry, compaction, subtask, step-start)
        // are not mapped to MessageChunk — they are opencode-internal.
        default:
          getLog().debug({ partType: part.type }, 'unhandled_part_type');
          break;
      }
    }
  }

  /**
   * Map an SSE event to zero or more MessageChunk values.
   */
  private mapEventToChunks(event: OpenCodeEvent, sessionId: string): MessageChunk[] {
    const chunks: MessageChunk[] = [];

    switch (event.type) {
      case 'message.part.updated': {
        const { part, delta } = event.properties;
        // For text parts with a delta, yield incremental text
        if (part.type === 'text' && delta) {
          chunks.push({ type: 'assistant', content: delta });
        } else if (part.type === 'reasoning' && delta) {
          chunks.push({ type: 'thinking', content: delta });
        } else if (part.type === 'tool') {
          const toolName = part.tool ?? 'unknown';
          if (part.state.status === 'running') {
            chunks.push({
              type: 'tool',
              toolName,
              toolInput: part.state.input ?? {},
            });
          } else if (part.state.status === 'completed') {
            chunks.push({
              type: 'tool_result',
              toolName,
              toolOutput: part.state.output ?? '',
            });
          } else if (part.state.status === 'error') {
            chunks.push({
              type: 'tool_result',
              toolName,
              toolOutput: `❌ Error: ${part.state.error ?? 'unknown error'}`,
            });
          }
        }
        break;
      }

      case 'message.updated': {
        const { info } = event.properties;
        // Only handle assistant messages with completion info
        if (info.role === 'assistant' && info.time.completed) {
          const usage = extractUsage(info);
          chunks.push({
            type: 'result',
            sessionId,
            tokens: usage,
            cost: info.cost,
          });
        }
        break;
      }

      case 'session.error': {
        const props = event.properties;
        if (props.error) {
          const errorMsg = extractErrorMessage(props.error);
          if (errorMsg) {
            chunks.push({ type: 'system', content: `❌ ${errorMsg}` });
          }
        }
        break;
      }

      case 'todo.updated': {
        const { todos } = event.properties;
        if (Array.isArray(todos) && todos.length > 0) {
          const taskList = todos
            .map(t => {
              const icon =
                t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜';
              return `${icon} ${t.content}`;
            })
            .join('\n');
          chunks.push({ type: 'system', content: `📋 Tasks:\n${taskList}` });
        }
        break;
      }

      // Other event types are not mapped to MessageChunk
      default:
        break;
    }

    return chunks;
  }

  /**
   * Get the assistant type identifier
   */
  getType(): string {
    return 'opencode';
  }
}
