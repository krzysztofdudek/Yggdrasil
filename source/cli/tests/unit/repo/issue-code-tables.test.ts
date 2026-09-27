// =============================================================================
// GUARD — the issue-code tables are rendered from the code registry.
//
// Every code the CLI can report is declared in model/issue-code.ts and described
// once in utils/issue-code-registry.ts: its severity rule, the stage that emits
// it, a one-line meaning and a fix. The two reference pages that list codes —
// docs/cli-reference.md (between its issue-codes markers) and the knowledge
// cli-reference topic (the whole of templates/knowledge/issue-codes-table.ts,
// which the topic interpolates) — are generated from that registry, so neither
// can list a code that does not exist or miss one that does. This test renders
// both and fails on any difference; `npm run codes:update`
// (generated-files.update.ts) rewrites them. This test only reads.
//
// It also holds the other direction: every table anywhere in the docs or the
// knowledge topics whose first column is headed `Code` lists registered codes
// only, and every `code: '…'` literal in the shipped source is registered.
//
// Hermetic & fast: reads files and imports the registry; spawns nothing.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ISSUE_CODES, issueCodeEntry } from '../../../src/utils/issue-code-registry.js';
import { CLI_ROOT, DOCS_PAGE, documentedCodes, END, KNOWLEDGE_DIR, KNOWLEDGE_TABLE, renderDocsBlock, renderKnowledgeModule, REPO_ROOT, START } from './issue-code-render.js';

describe('the issue-code tables are rendered from the registry', () => {
  it('every registered code has a meaning and a fix', () => {
    for (const code of ISSUE_CODES) {
      const e = issueCodeEntry(code)!;
      expect(e.meaning.trim(), `${code} meaning`).not.toBe('');
      expect(e.fix.trim(), `${code} fix`).not.toBe('');
      expect(e.meaning, `${code} meaning is one line`).not.toContain('\n');
      expect(e.fix, `${code} fix is one line`).not.toContain('\n');
    }
  });

  it('docs/cli-reference.md carries the rendered tables between its issue-codes markers', () => {
    const page = readFileSync(DOCS_PAGE, 'utf-8');
    const start = page.indexOf(START);
    const end = page.indexOf(END);
    expect(start, 'docs/cli-reference.md has no issue-codes start marker').toBeGreaterThan(-1);
    expect(end, 'docs/cli-reference.md has no issue-codes end marker').toBeGreaterThan(start);
    const current = page.slice(start, end + END.length);
    const rendered = renderDocsBlock();
    expect(current, 'the docs code tables differ from the registry — run npm run codes:update in source/cli').toBe(rendered);
  });

  it('the knowledge cli-reference topic interpolates the rendered tables', () => {
    const rendered = renderKnowledgeModule();
    expect(readFileSync(KNOWLEDGE_TABLE, 'utf-8'), 'the knowledge code tables differ from the registry — run npm run codes:update in source/cli').toBe(rendered);
    expect(readFileSync(path.join(KNOWLEDGE_DIR, 'cli-reference.ts'), 'utf-8')).toContain('${ISSUE_CODES_TABLE}');
  });

  it('every registered code is listed in both rendered tables, once', () => {
    const docs = documentedCodes(readFileSync(DOCS_PAGE, 'utf-8').split(START)[1].split(END)[0]);
    const knowledge = documentedCodes(readFileSync(KNOWLEDGE_TABLE, 'utf-8'));
    for (const listed of [docs, knowledge]) {
      expect([...listed].sort()).toEqual([...ISSUE_CODES].sort());
    }
  });

  it('every code a docs page or a knowledge topic lists in a Code table is registered', () => {
    const registered = new Set<string>(ISSUE_CODES);
    const sources: Array<[string, string]> = [];
    for (const f of readdirSync(path.join(REPO_ROOT, 'docs'))) {
      if (f.endsWith('.md')) sources.push([`docs/${f}`, readFileSync(path.join(REPO_ROOT, 'docs', f), 'utf-8')]);
    }
    for (const f of readdirSync(KNOWLEDGE_DIR)) {
      if (f.endsWith('.ts')) sources.push([`knowledge/${f}`, readFileSync(path.join(KNOWLEDGE_DIR, f), 'utf-8')]);
    }
    const unregistered: string[] = [];
    for (const [name, text] of sources) {
      for (const code of documentedCodes(text)) if (!registered.has(code)) unregistered.push(`${name}: ${code}`);
    }
    expect(unregistered, 'a page documents a code the CLI does not register').toEqual([]);
  });

  it('every code literal in the shipped source is registered', () => {
    // Codes of internal errors that never reach a reader under their own name:
    // the lock-writer's two failures surface as the command error
    // `lock-environment`.
    const internal = new Set(['approve-in-progress', 'lock-write-failed']);
    const registered = new Set<string>(ISSUE_CODES);
    const unregistered: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) {
          for (const m of readFileSync(full, 'utf-8').matchAll(/\bcode: '([a-z][a-z0-9]*(?:-[a-z0-9]+)*)'/g)) {
            if (!registered.has(m[1]) && !internal.has(m[1])) unregistered.push(`${path.relative(CLI_ROOT, full)}: ${m[1]}`);
          }
        }
      }
    };
    walk(path.join(CLI_ROOT, 'src'));
    expect(unregistered).toEqual([]);
  });
});
