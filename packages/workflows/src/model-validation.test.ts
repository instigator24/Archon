import { describe, it, expect } from 'bun:test';
import fc from 'fast-check';
import { isClaudeModel, isModelCompatible } from './model-validation';

describe('model-validation', () => {
  describe('isClaudeModel', () => {
    it('should recognize Claude aliases', () => {
      expect(isClaudeModel('sonnet')).toBe(true);
      expect(isClaudeModel('opus')).toBe(true);
      expect(isClaudeModel('haiku')).toBe(true);
      expect(isClaudeModel('inherit')).toBe(true);
    });

    it('should recognize claude- prefixed models', () => {
      expect(isClaudeModel('claude-sonnet-4-5-20250929')).toBe(true);
      expect(isClaudeModel('claude-opus-4-6')).toBe(true);
      expect(isClaudeModel('claude-3-5-sonnet-20241022')).toBe(true);
    });

    it('should reject non-Claude models', () => {
      expect(isClaudeModel('gpt-5.3-codex')).toBe(false);
      expect(isClaudeModel('gpt-5.2-codex')).toBe(false);
      expect(isClaudeModel('gpt-4')).toBe(false);
      expect(isClaudeModel('o1-mini')).toBe(false);
    });

    it('should reject empty string', () => {
      expect(isClaudeModel('')).toBe(false);
    });
  });

  describe('isModelCompatible', () => {
    it('should accept any model when model is undefined', () => {
      expect(isModelCompatible('claude')).toBe(true);
      expect(isModelCompatible('codex')).toBe(true);
    });

    it('should accept Claude models with claude provider', () => {
      expect(isModelCompatible('claude', 'sonnet')).toBe(true);
      expect(isModelCompatible('claude', 'opus')).toBe(true);
      expect(isModelCompatible('claude', 'haiku')).toBe(true);
      expect(isModelCompatible('claude', 'inherit')).toBe(true);
      expect(isModelCompatible('claude', 'claude-opus-4-6')).toBe(true);
    });

    it('should reject non-Claude models with claude provider', () => {
      expect(isModelCompatible('claude', 'gpt-5.3-codex')).toBe(false);
      expect(isModelCompatible('claude', 'gpt-4')).toBe(false);
    });

    it('should accept Codex/OpenAI models with codex provider', () => {
      expect(isModelCompatible('codex', 'gpt-5.3-codex')).toBe(true);
      expect(isModelCompatible('codex', 'gpt-5.2-codex')).toBe(true);
      expect(isModelCompatible('codex', 'gpt-4')).toBe(true);
      expect(isModelCompatible('codex', 'o1-mini')).toBe(true);
    });

    it('should reject Claude models with codex provider', () => {
      expect(isModelCompatible('codex', 'sonnet')).toBe(false);
      expect(isModelCompatible('codex', 'opus')).toBe(false);
      expect(isModelCompatible('codex', 'claude-opus-4-6')).toBe(false);
    });

    it('should handle empty string model', () => {
      // Empty string is falsy, so treated as "no model specified"
      expect(isModelCompatible('claude', '')).toBe(true);
      expect(isModelCompatible('codex', '')).toBe(true);
    });

    it('should accept non-Claude models with opencode provider', () => {
      expect(isModelCompatible('opencode', 'some-model')).toBe(true);
      expect(isModelCompatible('opencode', 'gpt-5.3-codex')).toBe(true);
      expect(isModelCompatible('opencode', 'anthropic/claude-sonnet-4-20250514')).toBe(true);
      expect(isModelCompatible('opencode', 'o1-mini')).toBe(true);
    });

    it('should reject Claude aliases with opencode provider', () => {
      expect(isModelCompatible('opencode', 'sonnet')).toBe(false);
      expect(isModelCompatible('opencode', 'opus')).toBe(false);
      expect(isModelCompatible('opencode', 'haiku')).toBe(false);
      expect(isModelCompatible('opencode', 'inherit')).toBe(false);
    });

    it('should reject claude- prefixed models with opencode provider', () => {
      expect(isModelCompatible('opencode', 'claude-3-opus')).toBe(false);
      expect(isModelCompatible('opencode', 'claude-sonnet-4-5-20250929')).toBe(false);
    });

    it('should accept undefined model with opencode provider', () => {
      expect(isModelCompatible('opencode')).toBe(true);
      expect(isModelCompatible('opencode', undefined)).toBe(true);
    });

    it('should handle empty string model with opencode provider', () => {
      expect(isModelCompatible('opencode', '')).toBe(true);
    });
  });

  describe('opencode model validation property tests', () => {
    /**
     * **Validates: Requirements 5.1, 5.2, 5.4**
     *
     * Property 5: Model validation for opencode rejects Claude aliases
     *
     * For any model string, isModelCompatible('opencode', model) returns false
     * iff the model matches a Claude alias (sonnet, opus, haiku, inherit, or
     * starts with claude-). For all other non-empty strings, returns true.
     */

    const CLAUDE_ALIASES = ['sonnet', 'opus', 'haiku', 'inherit'] as const;

    /** Arbitrary that generates a Claude alias (exact match) */
    const claudeAliasArb = fc.constantFrom(...CLAUDE_ALIASES);

    /** Arbitrary that generates a claude- prefixed string */
    const claudePrefixArb = fc.string({ minLength: 1 }).map(s => `claude-${s}`);

    /** Arbitrary that generates any Claude-matching model (alias or prefix) */
    const claudeModelArb = fc.oneof(claudeAliasArb, claudePrefixArb);

    /** Arbitrary that generates a non-empty string that is NOT a Claude alias */
    const nonClaudeModelArb = fc
      .string({ minLength: 1 })
      .filter(
        s =>
          !CLAUDE_ALIASES.includes(s as (typeof CLAUDE_ALIASES)[number]) && !s.startsWith('claude-')
      );

    it('rejects any Claude alias for opencode provider', () => {
      fc.assert(
        fc.property(claudeModelArb, model => {
          expect(isModelCompatible('opencode', model)).toBe(false);
        }),
        { numRuns: 100 }
      );
    });

    it('accepts any non-Claude, non-empty model for opencode provider', () => {
      fc.assert(
        fc.property(nonClaudeModelArb, model => {
          expect(isModelCompatible('opencode', model)).toBe(true);
        }),
        { numRuns: 100 }
      );
    });

    it('accepts undefined model for opencode provider', () => {
      expect(isModelCompatible('opencode', undefined)).toBe(true);
    });
  });
});
