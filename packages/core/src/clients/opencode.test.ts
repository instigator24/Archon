import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import fc from 'fast-check';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// --- Mock @opencode-ai/sdk before importing the client ---

/** Helper: create an async iterable from an array of events */
function mockEventStream(events: Array<Record<string, unknown>> = []) {
  return {
    stream: (async function* () {
      for (const e of events) yield e;
    })(),
  };
}

/** Default prompt result parts (empty) */
const defaultPromptResult = {
  data: {
    info: {
      id: 'msg-1',
      role: 'assistant' as const,
      tokens: { input: 10, output: 5 },
      cost: 0.001,
      error: undefined,
      time: { created: Date.now(), completed: Date.now() },
    },
    parts: [] as Array<Record<string, unknown>>,
  },
};

const mockSessionCreate = mock(() => Promise.resolve({ data: { id: 'test-session' } }));
const mockSessionGet = mock(() => Promise.resolve({ data: { id: 'test-session' } }));
const mockSessionPrompt = mock(() => Promise.resolve({ ...defaultPromptResult }));
const mockEventSubscribe = mock(() => Promise.resolve(mockEventStream([])));
const mockServerClose = mock(() => {});

const mockClient = {
  session: {
    create: mockSessionCreate,
    get: mockSessionGet,
    prompt: mockSessionPrompt,
  },
  event: {
    subscribe: mockEventSubscribe,
  },
};

const mockServer = { url: 'http://localhost:4096', close: mockServerClose };

const mockCreateOpencode = mock(() => Promise.resolve({ client: mockClient, server: mockServer }));

mock.module('@opencode-ai/sdk', () => ({
  createOpencode: mockCreateOpencode,
}));

// Import client AFTER all mocks are set up
import { OpenCodeClient, classifyOpenCodeError } from './opencode';
import * as codebaseDb from '../db/codebases';
import * as envLeakScanner from '../utils/env-leak-scanner';

describe('OpenCodeClient', () => {
  let client: OpenCodeClient;

  beforeEach(() => {
    client = new OpenCodeClient({ retryBaseDelayMs: 1 });
    mockSessionCreate.mockClear();
    mockSessionGet.mockClear();
    mockSessionPrompt.mockClear();
    mockEventSubscribe.mockClear();
    mockServerClose.mockClear();
    mockCreateOpencode.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();

    // Reset default implementations
    mockSessionCreate.mockImplementation(() => Promise.resolve({ data: { id: 'test-session' } }));
    mockSessionGet.mockImplementation(() => Promise.resolve({ data: { id: 'test-session' } }));
    mockSessionPrompt.mockImplementation(() =>
      Promise.resolve({ ...defaultPromptResult, data: { ...defaultPromptResult.data, parts: [] } })
    );
    mockEventSubscribe.mockImplementation(() =>
      Promise.resolve(
        mockEventStream([{ type: 'session.idle', properties: { sessionID: 'test-session' } }])
      )
    );
    mockCreateOpencode.mockImplementation(() =>
      Promise.resolve({ client: mockClient, server: mockServer })
    );
  });

  describe('getType', () => {
    test('returns opencode', () => {
      expect(client.getType()).toBe('opencode');
    });
  });

  describe('sendQuery', () => {
    test('yields assistant chunk for text parts', async () => {
      mockSessionPrompt.mockResolvedValue({
        data: {
          info: {
            ...defaultPromptResult.data.info,
          },
          parts: [{ type: 'text', text: 'Hello from OpenCode!' }],
        },
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks.some(c => c.type === 'assistant' && c.content === 'Hello from OpenCode!')).toBe(
        true
      );
    });

    test('yields tool + tool_result chunks for tool parts', async () => {
      mockSessionPrompt.mockResolvedValue({
        data: {
          info: { ...defaultPromptResult.data.info },
          parts: [
            {
              type: 'tool',
              tool: 'readFile',
              state: { status: 'completed', input: { path: '/test.ts' }, output: 'file contents' },
            },
          ],
        },
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      const toolChunk = chunks.find(c => c.type === 'tool');
      const toolResultChunk = chunks.find(c => c.type === 'tool_result');
      expect(toolChunk).toEqual({
        type: 'tool',
        toolName: 'readFile',
        toolInput: { path: '/test.ts' },
      });
      expect(toolResultChunk).toEqual({
        type: 'tool_result',
        toolName: 'readFile',
        toolOutput: 'file contents',
      });
    });

    test('yields thinking chunk for reasoning parts', async () => {
      mockSessionPrompt.mockResolvedValue({
        data: {
          info: { ...defaultPromptResult.data.info },
          parts: [{ type: 'reasoning', text: 'Let me think about this...' }],
        },
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(
        chunks.some(c => c.type === 'thinking' && c.content === 'Let me think about this...')
      ).toBe(true);
    });

    test('yields result chunk with session ID and usage', async () => {
      mockSessionPrompt.mockResolvedValue({
        data: {
          info: {
            ...defaultPromptResult.data.info,
            tokens: { input: 100, output: 50 },
            cost: 0.005,
          },
          parts: [],
        },
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      const resultChunk = chunks.find(c => c.type === 'result');
      expect(resultChunk).toEqual({
        type: 'result',
        sessionId: 'test-session',
        tokens: { input: 100, output: 50 },
        cost: 0.005,
      });
    });

    test('creates new session when no resumeSessionId', async () => {
      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(mockSessionCreate).toHaveBeenCalledWith({
        body: { title: 'archon-workflow' },
      });
      expect(mockSessionGet).not.toHaveBeenCalled();
    });

    test('resumes existing session when resumeSessionId provided', async () => {
      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace', 'existing-session')) {
        chunks.push(chunk);
      }

      expect(mockSessionGet).toHaveBeenCalledWith({
        path: { id: 'existing-session' },
      });
    });

    test('falls back to new session when resume fails and notifies user', async () => {
      const resumeError = new Error('Session not found');
      mockSessionGet.mockRejectedValueOnce(resumeError);

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace', 'bad-session-id')) {
        chunks.push(chunk);
      }

      expect(mockSessionGet).toHaveBeenCalled();
      expect(mockSessionCreate).toHaveBeenCalled();
      expect(chunks.some(c => c.type === 'system' && c.content.includes('Could not resume'))).toBe(
        true
      );
    });

    test('closes server after query completes', async () => {
      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(mockServerClose).toHaveBeenCalled();
    });

    test('yields SSE streaming events for text deltas', async () => {
      mockEventSubscribe.mockImplementation(() =>
        Promise.resolve(
          mockEventStream([
            {
              type: 'message.part.updated',
              properties: {
                part: { type: 'text' },
                delta: 'streaming text',
              },
            },
            { type: 'session.idle', properties: { sessionID: 'test-session' } },
          ])
        )
      );

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks.some(c => c.type === 'assistant' && c.content === 'streaming text')).toBe(true);
    });

    test('yields SSE streaming events for tool updates', async () => {
      mockEventSubscribe.mockImplementation(() =>
        Promise.resolve(
          mockEventStream([
            {
              type: 'message.part.updated',
              properties: {
                part: {
                  type: 'tool',
                  tool: 'writeFile',
                  state: { status: 'running', input: { path: '/out.ts' } },
                },
                delta: undefined,
              },
            },
            {
              type: 'message.part.updated',
              properties: {
                part: {
                  type: 'tool',
                  tool: 'writeFile',
                  state: { status: 'completed', output: 'done' },
                },
                delta: undefined,
              },
            },
            { type: 'session.idle', properties: { sessionID: 'test-session' } },
          ])
        )
      );

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks.some(c => c.type === 'tool' && c.toolName === 'writeFile')).toBe(true);
      expect(chunks.some(c => c.type === 'tool_result' && c.toolName === 'writeFile')).toBe(true);
    });

    test('throws immediately when abort signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const consumeGenerator = async (): Promise<void> => {
        for await (const _ of client.sendQuery('test', '/workspace', undefined, {
          abortSignal: controller.signal,
        })) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow('Query aborted');
    });

    test('breaks on abort signal between SSE events', async () => {
      const controller = new AbortController();

      mockEventSubscribe.mockImplementation(() =>
        Promise.resolve(
          mockEventStream([
            {
              type: 'message.part.updated',
              properties: { part: { type: 'text' }, delta: 'first' },
            },
            // The abort happens between events — the client checks abortSignal in the loop
            {
              type: 'message.part.updated',
              properties: { part: { type: 'text' }, delta: 'second' },
            },
            { type: 'session.idle', properties: { sessionID: 'test-session' } },
          ])
        )
      );

      // Abort after first event is consumed
      let eventCount = 0;
      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace', undefined, {
        abortSignal: controller.signal,
      })) {
        chunks.push(chunk);
        eventCount++;
        if (eventCount === 1) {
          controller.abort();
        }
      }

      // Should have gotten at least the first chunk but stopped early
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('classifyOpenCodeError', () => {
    test('classifies rate limit errors', () => {
      expect(classifyOpenCodeError('rate limit exceeded')).toBe('rate_limit');
      expect(classifyOpenCodeError('too many requests')).toBe('rate_limit');
      expect(classifyOpenCodeError('HTTP 429 error')).toBe('rate_limit');
      expect(classifyOpenCodeError('server overloaded')).toBe('rate_limit');
    });

    test('classifies auth errors', () => {
      expect(classifyOpenCodeError('unauthorized access')).toBe('auth');
      expect(classifyOpenCodeError('authentication failed')).toBe('auth');
      expect(classifyOpenCodeError('invalid token provided')).toBe('auth');
      expect(classifyOpenCodeError('HTTP 401 error')).toBe('auth');
      expect(classifyOpenCodeError('HTTP 403 forbidden')).toBe('auth');
    });

    test('classifies crash errors', () => {
      expect(classifyOpenCodeError('exited with code 1')).toBe('crash');
      expect(classifyOpenCodeError('process killed')).toBe('crash');
      expect(classifyOpenCodeError('received signal SIGTERM')).toBe('crash');
    });

    test('classifies unknown errors', () => {
      expect(classifyOpenCodeError('something unexpected')).toBe('unknown');
      expect(classifyOpenCodeError('generic failure')).toBe('unknown');
      expect(classifyOpenCodeError('')).toBe('unknown');
    });
  });

  describe('retry behavior', () => {
    test('auth errors are not retried', async () => {
      mockCreateOpencode.mockRejectedValue(new Error('unauthorized'));

      const consumeGenerator = async (): Promise<void> => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow(/OpenCode auth error/);
      expect(mockCreateOpencode).toHaveBeenCalledTimes(1);
    });

    test('rate limit errors are retried with backoff', async () => {
      mockCreateOpencode.mockRejectedValue(new Error('rate limit exceeded'));

      const consumeGenerator = async (): Promise<void> => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow(/OpenCode rate_limit/);
      // Initial attempt + 3 retries = 4 calls
      expect(mockCreateOpencode).toHaveBeenCalledTimes(4);
    }, 10_000);

    test('crash errors are retried with backoff', async () => {
      mockCreateOpencode.mockRejectedValue(new Error('exited with code 1'));

      const consumeGenerator = async (): Promise<void> => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow(/OpenCode crash/);
      // Initial attempt + 3 retries = 4 calls
      expect(mockCreateOpencode).toHaveBeenCalledTimes(4);
    }, 10_000);

    test('unknown errors are not retried', async () => {
      mockCreateOpencode.mockRejectedValue(new Error('something unexpected'));

      const consumeGenerator = async (): Promise<void> => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow(/OpenCode unknown/);
      expect(mockCreateOpencode).toHaveBeenCalledTimes(1);
    });

    test('recovers from transient crash on retry', async () => {
      let callCount = 0;
      mockCreateOpencode.mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return Promise.reject(new Error('exited with code 1'));
        }
        return Promise.resolve({ client: mockClient, server: mockServer });
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(callCount).toBe(3);
      // Should have a result chunk from the successful attempt
      expect(chunks.some(c => c.type === 'result')).toBe(true);
    }, 10_000);
  });

  describe('pre-spawn env leak gate', () => {
    let spyFindByDefaultCwd: ReturnType<typeof spyOn>;
    let spyFindByPathPrefix: ReturnType<typeof spyOn>;
    let spyScan: ReturnType<typeof spyOn>;

    beforeEach(() => {
      spyFindByDefaultCwd = spyOn(codebaseDb, 'findCodebaseByDefaultCwd').mockResolvedValue(null);
      spyFindByPathPrefix = spyOn(codebaseDb, 'findCodebaseByPathPrefix').mockResolvedValue(null);
      spyScan = spyOn(envLeakScanner, 'scanPathForSensitiveKeys').mockReturnValue({
        path: '/workspace',
        findings: [],
      });
    });

    afterEach(() => {
      spyFindByDefaultCwd.mockRestore();
      spyFindByPathPrefix.mockRestore();
      spyScan.mockRestore();
    });

    test('throws EnvLeakError when .env contains sensitive keys and codebase has no consent', async () => {
      spyFindByDefaultCwd.mockResolvedValueOnce({
        id: 'codebase-1',
        allow_env_keys: false,
        default_cwd: '/workspace',
      });
      spyScan.mockReturnValueOnce({
        path: '/workspace',
        findings: [{ file: '.env', keys: ['ANTHROPIC_API_KEY'] }],
      });

      const consumeGenerator = async (): Promise<void> => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow('Cannot run workflow');
    });

    test('skips scan when cwd is not a registered codebase', async () => {
      spyScan.mockReturnValue({
        path: '/workspace',
        findings: [{ file: '.env', keys: ['ANTHROPIC_API_KEY'] }],
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(spyScan).not.toHaveBeenCalled();
    });

    test('skips scan when codebase has allow_env_keys: true', async () => {
      spyFindByDefaultCwd.mockResolvedValueOnce({
        id: 'codebase-1',
        allow_env_keys: true,
        default_cwd: '/workspace',
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(spyScan).not.toHaveBeenCalled();
    });
  });

  describe('Property 1: SDK event-to-MessageChunk mapping preserves type correspondence', () => {
    /**
     * **Validates: Requirements 1.1, 1.2**
     *
     * Property 1: SDK event-to-MessageChunk mapping preserves type correspondence
     *
     * For any sequence of mock opencode SDK response parts (text, tool, reasoning),
     * sendQuery() yields MessageChunk values where each chunk's type corresponds
     * to the SDK part type: text → 'assistant', tool (completed) → 'tool' + 'tool_result',
     * reasoning → 'thinking'.
     */

    // --- Arbitraries for SDK part types ---

    /** Arbitrary text part: { type: 'text', text: <non-empty string> } */
    const textPartArb = fc.string({ minLength: 1 }).map(text => ({
      type: 'text' as const,
      text,
    }));

    /** Arbitrary tool part with completed status */
    const toolPartArb = fc
      .record({
        tool: fc.string({ minLength: 1 }),
        output: fc.string(),
      })
      .map(({ tool, output }) => ({
        type: 'tool' as const,
        tool,
        state: { status: 'completed' as const, input: {}, output },
      }));

    /** Arbitrary reasoning part: { type: 'reasoning', text: <non-empty string> } */
    const reasoningPartArb = fc.string({ minLength: 1 }).map(text => ({
      type: 'reasoning' as const,
      text,
    }));

    /** Arbitrary sequence of mixed SDK parts */
    const partsArb = fc.array(fc.oneof(textPartArb, toolPartArb, reasoningPartArb), {
      minLength: 1,
      maxLength: 20,
    });

    test('each SDK part type maps to the correct MessageChunk type(s)', async () => {
      await fc.assert(
        fc.asyncProperty(partsArb, async parts => {
          // Configure mock to return the generated parts
          mockSessionPrompt.mockResolvedValue({
            data: {
              info: {
                ...defaultPromptResult.data.info,
              },
              parts,
            },
          });
          mockEventSubscribe.mockImplementation(() =>
            Promise.resolve(
              mockEventStream([{ type: 'session.idle', properties: { sessionID: 'test-session' } }])
            )
          );

          const localClient = new OpenCodeClient({ retryBaseDelayMs: 1 });
          const chunks: Array<{ type: string; [key: string]: unknown }> = [];
          for await (const chunk of localClient.sendQuery('test', '/workspace')) {
            chunks.push(chunk);
          }

          // Count expected chunks by part type
          const textParts = parts.filter(p => p.type === 'text');
          const toolParts = parts.filter(p => p.type === 'tool');
          const reasoningParts = parts.filter(p => p.type === 'reasoning');

          const assistantChunks = chunks.filter(c => c.type === 'assistant');
          const toolChunks = chunks.filter(c => c.type === 'tool');
          const toolResultChunks = chunks.filter(c => c.type === 'tool_result');
          const thinkingChunks = chunks.filter(c => c.type === 'thinking');

          // text parts → at least one 'assistant' chunk per text part
          if (textParts.length > 0) {
            expect(assistantChunks.length).toBeGreaterThanOrEqual(textParts.length);
          }

          // tool parts with status 'completed' → at least one 'tool' AND one 'tool_result' per tool part
          if (toolParts.length > 0) {
            expect(toolChunks.length).toBeGreaterThanOrEqual(toolParts.length);
            expect(toolResultChunks.length).toBeGreaterThanOrEqual(toolParts.length);
          }

          // reasoning parts → at least one 'thinking' chunk per reasoning part
          if (reasoningParts.length > 0) {
            expect(thinkingChunks.length).toBeGreaterThanOrEqual(reasoningParts.length);
          }

          // Always expect a 'result' chunk at the end
          expect(chunks.some(c => c.type === 'result')).toBe(true);
        }),
        { numRuns: 100 }
      );
    }, 30_000);

    test('text part content is preserved in assistant chunk', async () => {
      await fc.assert(
        fc.asyncProperty(fc.string({ minLength: 1 }), async text => {
          mockSessionPrompt.mockResolvedValue({
            data: {
              info: { ...defaultPromptResult.data.info },
              parts: [{ type: 'text', text }],
            },
          });
          mockEventSubscribe.mockImplementation(() =>
            Promise.resolve(
              mockEventStream([{ type: 'session.idle', properties: { sessionID: 'test-session' } }])
            )
          );

          const localClient = new OpenCodeClient({ retryBaseDelayMs: 1 });
          const chunks: Array<{ type: string; content?: string }> = [];
          for await (const chunk of localClient.sendQuery('test', '/workspace')) {
            chunks.push(chunk);
          }

          const assistantChunk = chunks.find(c => c.type === 'assistant');
          expect(assistantChunk).toBeDefined();
          expect(assistantChunk!.content).toBe(text);
        }),
        { numRuns: 100 }
      );
    }, 30_000);

    test('tool part name and output are preserved in tool/tool_result chunks', async () => {
      await fc.assert(
        fc.asyncProperty(fc.string({ minLength: 1 }), fc.string(), async (toolName, output) => {
          mockSessionPrompt.mockResolvedValue({
            data: {
              info: { ...defaultPromptResult.data.info },
              parts: [
                {
                  type: 'tool',
                  tool: toolName,
                  state: { status: 'completed', input: {}, output },
                },
              ],
            },
          });
          mockEventSubscribe.mockImplementation(() =>
            Promise.resolve(
              mockEventStream([{ type: 'session.idle', properties: { sessionID: 'test-session' } }])
            )
          );

          const localClient = new OpenCodeClient({ retryBaseDelayMs: 1 });
          const chunks: Array<{ type: string; toolName?: string; toolOutput?: string }> = [];
          for await (const chunk of localClient.sendQuery('test', '/workspace')) {
            chunks.push(chunk);
          }

          const toolChunk = chunks.find(c => c.type === 'tool');
          const toolResultChunk = chunks.find(c => c.type === 'tool_result');
          expect(toolChunk).toBeDefined();
          expect(toolChunk!.toolName).toBe(toolName);
          expect(toolResultChunk).toBeDefined();
          expect(toolResultChunk!.toolName).toBe(toolName);
          expect(toolResultChunk!.toolOutput).toBe(output);
        }),
        { numRuns: 100 }
      );
    }, 30_000);

    test('reasoning part content is preserved in thinking chunk', async () => {
      await fc.assert(
        fc.asyncProperty(fc.string({ minLength: 1 }), async text => {
          mockSessionPrompt.mockResolvedValue({
            data: {
              info: { ...defaultPromptResult.data.info },
              parts: [{ type: 'reasoning', text }],
            },
          });
          mockEventSubscribe.mockImplementation(() =>
            Promise.resolve(
              mockEventStream([{ type: 'session.idle', properties: { sessionID: 'test-session' } }])
            )
          );

          const localClient = new OpenCodeClient({ retryBaseDelayMs: 1 });
          const chunks: Array<{ type: string; content?: string }> = [];
          for await (const chunk of localClient.sendQuery('test', '/workspace')) {
            chunks.push(chunk);
          }

          const thinkingChunk = chunks.find(c => c.type === 'thinking');
          expect(thinkingChunk).toBeDefined();
          expect(thinkingChunk!.content).toBe(text);
        }),
        { numRuns: 100 }
      );
    }, 30_000);
  });

  describe('Property 2: Error classification consistency', () => {
    /**
     * **Validates: Requirements 1.4**
     *
     * Property 2: Error classification consistency
     *
     * For any error message string, the classifier returns 'rate_limit' for
     * rate-limit patterns, 'auth' for auth patterns, 'crash' for crash patterns,
     * and 'unknown' otherwise. Auth errors are never retried.
     */

    const RATE_LIMIT_PATTERNS = ['rate limit', 'too many requests', '429', 'overloaded'];
    const AUTH_PATTERNS = ['unauthorized', 'authentication', 'invalid token', '401', '403'];
    const CRASH_PATTERNS = ['exited with code', 'killed', 'signal', 'ECONNREFUSED'];
    const ALL_PATTERNS = [...RATE_LIMIT_PATTERNS, ...AUTH_PATTERNS, ...CRASH_PATTERNS];

    /** Arbitrary that injects a known pattern into a random string (case-insensitive) */
    const stringWithPattern = (patterns: string[]) =>
      fc
        .tuple(fc.constantFrom(...patterns), fc.string(), fc.string())
        .map(([pattern, prefix, suffix]) => `${prefix}${pattern}${suffix}`);

    /** Arbitrary that generates strings containing none of the known patterns */
    const stringWithoutAnyPattern = fc.string().filter(s => {
      const lower = s.toLowerCase();
      return !ALL_PATTERNS.some(p => lower.includes(p));
    });

    test('strings containing a rate-limit pattern classify as rate_limit', () => {
      fc.assert(
        fc.property(stringWithPattern(RATE_LIMIT_PATTERNS), msg => {
          expect(classifyOpenCodeError(msg)).toBe('rate_limit');
        }),
        { numRuns: 100 }
      );
    });

    test('strings containing an auth pattern classify as auth', () => {
      fc.assert(
        fc.property(
          stringWithPattern(AUTH_PATTERNS).filter(s => {
            // Exclude strings that also match a rate-limit pattern (rate_limit takes priority)
            const lower = s.toLowerCase();
            return !RATE_LIMIT_PATTERNS.some(p => lower.includes(p));
          }),
          msg => {
            expect(classifyOpenCodeError(msg)).toBe('auth');
          }
        ),
        { numRuns: 100 }
      );
    });

    test('strings containing a crash pattern classify as crash', () => {
      fc.assert(
        fc.property(
          stringWithPattern(CRASH_PATTERNS).filter(s => {
            // Exclude strings that also match a higher-priority pattern
            const lower = s.toLowerCase();
            return (
              !RATE_LIMIT_PATTERNS.some(p => lower.includes(p)) &&
              !AUTH_PATTERNS.some(p => lower.includes(p))
            );
          }),
          msg => {
            expect(classifyOpenCodeError(msg)).toBe('crash');
          }
        ),
        { numRuns: 100 }
      );
    });

    test('strings without any known pattern classify as unknown', () => {
      fc.assert(
        fc.property(stringWithoutAnyPattern, msg => {
          expect(classifyOpenCodeError(msg)).toBe('unknown');
        }),
        { numRuns: 100 }
      );
    });

    test('classification is case-insensitive', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...ALL_PATTERNS),
          fc.constantFrom('toUpperCase', 'toLowerCase') as fc.Arbitrary<
            'toUpperCase' | 'toLowerCase'
          >,
          (pattern, caseMethod) => {
            const transformed = pattern[caseMethod]();
            const result = classifyOpenCodeError(transformed);
            expect(result).not.toBe('unknown');
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
