import { describe, it, expect } from 'vitest';
import { redactSecrets, redactedTail } from '../../../src/utils/redact.js';

describe('redactSecrets', () => {
  it.each([
    ['token sk-ant-api03-abcdefghijklmnop', 'token sk-ant-[REDACTED]'],
    ['key sk-proj-abcdefghijklmnop', 'key sk-proj-[REDACTED]'],
    ['ghp_abcdefghijklmnop1234 expired', 'ghp_[REDACTED] expired'],
    ['AIzaSyA-abcdefghijklmnop', 'AIza[REDACTED]'],
    ['Authorization: Bearer abc.def.ghijklmnop', 'Authorization: Bearer [REDACTED]'],
    ['api_key=supersecretvalue', 'api_key=[REDACTED]'],
  ])('masks %s', (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it('leaves ordinary diagnostics alone', () => {
    expect(redactSecrets('Invalid API key · Please run /login')).toBe('Invalid API key · Please run /login');
  });
});

describe('redactedTail', () => {
  it('keeps the end, on one line', () => {
    expect(redactedTail('a\nb\n  c', 300)).toBe('a b c');
    expect(redactedTail('x'.repeat(10) + 'END', 5)).toBe('…xxEND');
  });

  it('is empty for empty input', () => {
    expect(redactedTail('')).toBe('');
  });
});
