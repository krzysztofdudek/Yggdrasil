// =============================================================================
// GUARD — one word, one meaning: retired synonyms stay retired.
//
// The same idea used to go by several names across the docs, the README, the
// prime manual, the knowledge topics and the CLI's own messages ("LLM aspect",
// "judgment rule" and "reviewer rule" for one kind of rule; "standing" and
// "enforcement level" for a rule's status; "drill into" for a view that is not
// `yg drill`). The Glossary (docs/glossary.md, generated from the portal's
// glossary.js) now fixes one word for each, and lists the retired ones under
// "Not called". This guard fails the moment a retired word comes back on a
// surface a reader or an agent sees. The glossary itself names them on purpose
// and is not scanned; neither are CHANGELOG.md and the graph's own logs, which
// are history, nor code comments, which no user reads.
//
// Hermetic & fast: reads files via fs; spawns nothing.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');

/** Prose surfaces: every line counts. */
const PROSE_DIRS = ['docs', 'source/cli/src/templates', 'examples'];
const PROSE_FILES = ['README.md', 'source/cli/README.md'];
/** CLI source: only the lines that are not comments (the strings a user sees live there). */
const CODE_DIRS = ['source/cli/src'];
const EXTENSIONS = new Set(['.md', '.ts', '.js', '.yaml', '.yml']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.vitepress', '.git', 'coverage', 'vendor']);
/** The glossary lists the retired words under "Not called" by design. */
const SKIP_FILES = new Set(['docs/glossary.md', 'source/cli/src/templates/portal/js/glossary.js']);

/** Retired word -> the word the Glossary uses instead. */
const RETIRED: Array<{ pattern: RegExp; use: string }> = [
  { pattern: /\bLLM (aspect|rule)s?\b/i, use: 'reviewer rule' },
  { pattern: /\bdeterministic (aspect|rule)s?\b/i, use: 'script rule' },
  { pattern: /\bjudgment (aspect|rule)s?\b/i, use: 'reviewer rule' },
  { pattern: /\ban reviewer\b/i, use: 'a reviewer' },
  { pattern: /\breviewer kinds?\b/i, use: 'rule kind' },
  { pattern: /\bkinds? of reviewer\b/i, use: 'rule kind' },
  { pattern: /\b(deterministic|aggregating) reviewer\b/i, use: 'script rule / bundle' },
  { pattern: /\b(add|configure|no|a) judge\b/i, use: 'reviewer' },
  { pattern: /\b(approving|recording) run\b/i, use: 'fill' },
  { pattern: /\bverifies the unverified\b/i, use: 'fills the unverified pairs' },
  { pattern: /\buncovered hot spot\b/i, use: 'unguarded hot spot' },
  // Case-sensitive: a TypeScript `type Tier` alias is code, not the retired word.
  { pattern: /\btype tier\b/, use: 'type-level coverage' },
  { pattern: /\bcoverage tiers?\b/i, use: 'coverage levels' },
  { pattern: /\blattice\b/i, use: 'type-level coverage' },
  { pattern: /\bcomponent-free\b/i, use: 'type-covered file' },
  { pattern: /\bfile-level waiver\b/i, use: 'line-scoped waiver' },
  { pattern: /\bdrill into\b/i, use: 'focus on one rule (yg check --aspect)' },
  { pattern: /\bdrill-in\b/i, use: 'focus on one rule (yg check --aspect)' },
  { pattern: /\benforcement levels?\b/i, use: 'status' },
  { pattern: /\bchange of standing\b/i, use: 'change of status' },
  { pattern: /\bstandings\b/i, use: 'statuses' },
];

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (EXTENSIONS.has(path.extname(name)) && name !== 'log.md') out.push(abs);
  }
}

const COMMENT = /^\s*(\/\/|\*|\/\*)/;

function scan(files: string[], codeOnly: boolean, hits: string[]): void {
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    if (SKIP_FILES.has(rel)) continue;
    readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
      if (codeOnly && COMMENT.test(line)) return;
      for (const { pattern, use } of RETIRED) {
        const m = pattern.exec(line);
        if (m) hits.push(`${rel}:${i + 1} says "${m[0]}" — the Glossary word is "${use}"`);
      }
    });
  }
}

describe('retired terms are not used', () => {
  it('no adopter-facing prose uses a retired synonym', () => {
    const files: string[] = [];
    for (const d of PROSE_DIRS) walk(path.join(REPO_ROOT, d), files);
    for (const f of PROSE_FILES) if (existsSync(path.join(REPO_ROOT, f))) files.push(path.join(REPO_ROOT, f));
    expect(files.length).toBeGreaterThan(20);
    const hits: string[] = [];
    scan(files, false, hits);
    expect(hits).toEqual([]);
  });

  it('no CLI message uses a retired synonym', () => {
    const files: string[] = [];
    for (const d of CODE_DIRS) walk(path.join(REPO_ROOT, d), files);
    const templates = path.join(REPO_ROOT, 'source/cli/src/templates') + path.sep;
    const code = files.filter((f) => !f.startsWith(templates));
    expect(code.length).toBeGreaterThan(50);
    const hits: string[] = [];
    scan(code, true, hits);
    expect(hits).toEqual([]);
  });
});
