import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';
import { getAssistantClient } from './factory';

describe('factory', () => {
  describe('getAssistantClient', () => {
    test('returns ClaudeClient for claude type', () => {
      const client = getAssistantClient('claude');

      expect(client).toBeDefined();
      expect(client.getType()).toBe('claude');
      expect(typeof client.sendQuery).toBe('function');
    });

    test('returns CodexClient for codex type', () => {
      const client = getAssistantClient('codex');

      expect(client).toBeDefined();
      expect(client.getType()).toBe('codex');
      expect(typeof client.sendQuery).toBe('function');
    });

    test('returns OpenCodeClient for opencode type', () => {
      const client = getAssistantClient('opencode');

      expect(client).toBeDefined();
      expect(client.getType()).toBe('opencode');
      expect(typeof client.sendQuery).toBe('function');
    });

    test('throws error for unknown type listing all three providers', () => {
      expect(() => getAssistantClient('unknown')).toThrow(
        "Unknown assistant type: unknown. Supported types: 'claude', 'codex', 'opencode'"
      );
      // Verify all three providers are mentioned in the error
      try {
        getAssistantClient('unknown');
      } catch (e: unknown) {
        const msg = (e as Error).message;
        expect(msg).toContain('claude');
        expect(msg).toContain('codex');
        expect(msg).toContain('opencode');
      }
    });

    test('throws error for empty string', () => {
      expect(() => getAssistantClient('')).toThrow(
        "Unknown assistant type: . Supported types: 'claude', 'codex', 'opencode'"
      );
    });

    test('is case sensitive - Claude throws', () => {
      expect(() => getAssistantClient('Claude')).toThrow(
        "Unknown assistant type: Claude. Supported types: 'claude', 'codex', 'opencode'"
      );
    });

    test('each call returns new instance', () => {
      const client1 = getAssistantClient('claude');
      const client2 = getAssistantClient('claude');

      // Each call should return a new instance
      expect(client1).not.toBe(client2);
    });
  });

  /**
   * Property 3: Unknown provider rejection
   *
   * For any string that is not 'claude', 'codex', or 'opencode',
   * getAssistantClient() throws an error whose message contains
   * all three supported provider names.
   *
   * **Validates: Requirements 2.2**
   */
  describe('Property 3: Unknown provider rejection', () => {
    const VALID_PROVIDERS = ['claude', 'codex', 'opencode'];

    const invalidProviderArb = fc.string().filter(s => !VALID_PROVIDERS.includes(s));

    test('any non-valid provider string throws an error mentioning all three supported providers', () => {
      fc.assert(
        fc.property(invalidProviderArb, provider => {
          expect(() => getAssistantClient(provider)).toThrow();

          try {
            getAssistantClient(provider);
          } catch (e: unknown) {
            const msg = (e as Error).message;
            expect(msg).toContain('claude');
            expect(msg).toContain('codex');
            expect(msg).toContain('opencode');
          }
        }),
        { numRuns: 100 }
      );
    });
  });
});
