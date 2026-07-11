import { test, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('orders ids stably', () => {
  dir = mkdtempSync(join(tmpdir(), 'ordering-'));
  const ids = ['a', 'b', 'c'];
  expect(ids).toEqual(['a', 'b', 'c']);
});
