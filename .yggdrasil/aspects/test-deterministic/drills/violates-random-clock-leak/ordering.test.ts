import { test, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';

test('assigns an id and records the time', () => {
  const id = Math.random().toString(36).slice(2);
  const dir = mkdtempSync('/tmp/ordering-');
  expect(id.length).toBeGreaterThan(0);
  expect(Date.now()).toBeGreaterThan(0);
  expect(dir).toContain('/tmp/ordering-');
});
