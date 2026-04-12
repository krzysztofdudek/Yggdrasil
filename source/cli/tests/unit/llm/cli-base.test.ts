import { describe, it, expect } from 'vitest';
import { parseAspectResponse } from '../../../src/llm/cli-base.js';

describe('parseAspectResponse', () => {
  it('parses clean JSON', () => {
    const result = parseAspectResponse('{"satisfied": true, "reason": "ok"}');
    expect(result).toEqual({ satisfied: true, reason: 'ok' });
  });

  it('parses JSON in markdown fence', () => {
    const result = parseAspectResponse('```json\n{"satisfied": false, "reason": "fail"}\n```');
    expect(result).toEqual({ satisfied: false, reason: 'fail' });
  });

  it('extracts embedded JSON from text', () => {
    const result = parseAspectResponse('Here is my analysis: {"satisfied": true, "reason": "pass"} done.');
    expect(result).toEqual({ satisfied: true, reason: 'pass' });
  });

  it('returns undefined for empty string', () => {
    expect(parseAspectResponse('')).toBeUndefined();
  });

  it('falls back to natural language — satisfied', () => {
    const result = parseAspectResponse('The code is satisfied with all requirements.');
    expect(result?.satisfied).toBe(true);
  });

  it('falls back to natural language — not satisfied', () => {
    const result = parseAspectResponse('The code is not satisfied with requirement X.');
    expect(result?.satisfied).toBe(false);
  });

  it('falls back conservative on ambiguous text', () => {
    const result = parseAspectResponse('I cannot determine if the code is satisfied.');
    expect(result?.satisfied).toBe(false);
  });
});
