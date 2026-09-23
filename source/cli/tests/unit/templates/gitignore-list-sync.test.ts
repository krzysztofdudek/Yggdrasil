import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { YGGDRASIL_GITIGNORE_LINES } from '../../../src/cli/init-scaffold.js';
import { content as configurationTopic } from '../../../src/templates/knowledge/configuration.js';

// The list of what `.yggdrasil/.gitignore` holds is written out by hand on
// two surfaces besides the code that writes it. Hand copies drift (one lost
// the rotation globs and the family-candidates lines), so each copy is
// compared with the one list init actually writes.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const WRITTEN = [...YGGDRASIL_GITIGNORE_LINES].sort();

function section(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  expect(start, `missing section start: ${startMarker}`).toBeGreaterThan(-1);
  const end = text.indexOf(endMarker, start + startMarker.length);
  expect(end, `missing section end: ${endMarker}`).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe('.yggdrasil/.gitignore list: one source, every copy equal', () => {
  it('docs/configuration.md "Local state" table', () => {
    const md = readFileSync(path.join(REPO_ROOT, 'docs', 'configuration.md'), 'utf-8');
    const table = section(md, '## Local state', '\nEvery one of them is rebuildable');
    const entries = [...table.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]).sort();
    expect(entries).toEqual(WRITTEN);
  });

  it('knowledge topic "configuration", Local state block', () => {
    const block = section(configurationTopic, '## Local state (.yggdrasil/.gitignore)', '\n```\n\nIt is written');
    const body = block.slice(block.indexOf('```\n') + 4);
    const entries = body.split('\n').filter((l) => l.trim() !== '').map((l) => l.split(/\s+#/)[0].trim()).sort();
    expect(entries).toEqual(WRITTEN);
  });
});
