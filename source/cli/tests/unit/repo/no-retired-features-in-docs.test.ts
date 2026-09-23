// =============================================================================
// GUARD — a removed feature must not be described as current.
//
// The port contract baseline was removed in 6.0.0, yet the operating manual and
// two docs pages kept saying that the free deterministic fill "writes a port's
// contract baseline". Copies of one fact typed out by hand drift apart; this
// guard fails the moment any copy a reader or an agent sees names the retired
// feature again. It scans what adopters read: the docs site, the READMEs, and
// the templates the CLI prints (the prime manual and the knowledge topics).
// CHANGELOG.md and the graph's own logs are history and are not scanned.
//
// Hermetic & fast: reads files via fs; spawns nothing.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');

const SCAN_DIRS = ['docs', 'source/cli/src/templates', 'examples'];
const SCAN_FILES = ['README.md', 'source/cli/README.md'];
const EXTENSIONS = new Set(['.md', '.ts', '.yaml', '.yml']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.vitepress', '.git', 'coverage']);

/** Phrases that describe a removed feature as if it still existed. */
const RETIRED = [{ pattern: /contract baseline/i, feature: 'the port contract baseline (removed in 6.0.0)' }];

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (EXTENSIONS.has(path.extname(name)) && name !== 'log.md') out.push(abs);
  }
}

describe('retired features are not described as current', () => {
  it('no adopter-facing surface mentions a removed feature', () => {
    const files: string[] = [];
    for (const d of SCAN_DIRS) walk(path.join(REPO_ROOT, d), files);
    for (const f of SCAN_FILES) if (existsSync(path.join(REPO_ROOT, f))) files.push(path.join(REPO_ROOT, f));
    expect(files.length).toBeGreaterThan(20);

    const hits: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        for (const { pattern, feature } of RETIRED) {
          if (pattern.test(line)) hits.push(`${path.relative(REPO_ROOT, file)}:${i + 1} names ${feature}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});
