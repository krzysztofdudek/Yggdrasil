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
// both and fails on any difference; with YG_CODES_UPDATE=1 (npm run
// codes:update) it rewrites them instead.
//
// It also holds the other direction: every table anywhere in the docs or the
// knowledge topics whose first column is headed `Code` lists registered codes
// only, and every `code: '…'` literal in the shipped source is registered.
//
// Hermetic & fast: reads files and imports the registry; spawns nothing.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ISSUE_CODES, issueCodeEntry, type IssueCodeEntry, type IssueStage } from '../../../src/utils/issue-code-registry.js';
import { APPROVE_GATING_CODES, APPROVE_LOG_STATE_GATING_CODES, SCOPED_CODES } from '../../../src/utils/check-codes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(__dirname, '..', '..', '..');
const REPO_ROOT = path.resolve(CLI_ROOT, '..', '..');
const DOCS_PAGE = path.join(REPO_ROOT, 'docs', 'cli-reference.md');
const KNOWLEDGE_DIR = path.join(CLI_ROOT, 'src', 'templates', 'knowledge');
const KNOWLEDGE_TABLE = path.join(KNOWLEDGE_DIR, 'issue-codes-table.ts');
const UPDATE = process.env.YG_CODES_UPDATE === '1';

const START = '<!-- issue-codes:start — generated from source/cli/src/utils/issue-code-registry.ts; edit the registry, then run npm run codes:update in source/cli -->';
const END = '<!-- issue-codes:end -->';

/** The stages in the order the tables list them, each with its heading and anchor. */
const STAGES: ReadonlyArray<{ stage: IssueStage; heading: string; anchor: string }> = [
  { stage: 'load', heading: 'Loading the graph', anchor: 'codes-load' },
  { stage: 'validate', heading: 'Graph validation', anchor: 'codes-validate' },
  { stage: 'verify', heading: 'Pairs and the lock', anchor: 'codes-verify' },
  { stage: 'relations', heading: 'Relation conformance', anchor: 'codes-relations' },
  { stage: 'coverage', heading: 'Coverage', anchor: 'codes-coverage' },
  { stage: 'log', heading: 'The log gate', anchor: 'codes-log' },
  { stage: 'fill', heading: 'Reported by a fill only', anchor: 'codes-fill' },
  { stage: 'command', heading: 'Command errors (`yg-error/1`)', anchor: 'codes-command' },
  { stage: 'package', heading: 'Packages (`yg pack`)', anchor: 'codes-package' },
  { stage: 'suppressions', heading: 'Suppression markers (`yg suppressions`)', anchor: 'codes-suppressions' },
  { stage: 'marketplace', heading: 'Marketplace check (`yg marketplace check`)', anchor: 'codes-marketplace' },
];

const SEVERITY_WORDS: Record<IssueCodeEntry['severity'], string> = {
  error: 'error',
  warning: 'warning',
  'by-status': 'error (enforced) / warning (advisory)',
  'by-coverage-root': 'error (required root) / warning',
};

/**
 * A table cell: one line, pipes escaped. For the docs site, an angle bracket
 * outside a code span is escaped too — the site's renderer reads `<node>` in
 * prose as an HTML element and refuses the page.
 */
function cell(text: string, html: boolean): string {
  const piped = text.replace(/\|/g, '\\|');
  if (!html) return piped;
  return piped
    .split(/(`[^`]*`)/)
    .map((part) => (part.startsWith('`') ? part : part.replace(/</g, '&lt;').replace(/>/g, '&gt;')))
    .join('');
}

function severityCell(code: string, e: IssueCodeEntry): string {
  const parts = [SEVERITY_WORDS[e.severity]];
  if (APPROVE_GATING_CODES.has(code) || APPROVE_LOG_STATE_GATING_CODES.has(code)) parts.push('stops `--approve`');
  if (SCOPED_CODES.has(code)) parts.push('a warning outside your change');
  return parts.join(' · ');
}

function codeCell(code: string, e: IssueCodeEntry): string {
  return e.label !== undefined && e.label !== code ? `\`${code}\` (heads as \`${e.label}\`)` : `\`${code}\``;
}

/** The tables, as markdown: one per stage, every registered code once. */
function renderTables(withAnchors: boolean): string {
  const out: string[] = [];
  for (const { stage, heading, anchor } of STAGES) {
    const codes = ISSUE_CODES.filter((c) => issueCodeEntry(c)!.stage === stage);
    if (codes.length === 0) continue;
    out.push(`### ${heading}${withAnchors ? ` {#${anchor}}` : ''}`, '', '| Code | Severity | Meaning | Fix |', '|------|----------|---------|-----|');
    for (const code of codes) {
      const e = issueCodeEntry(code)!;
      out.push(`| ${codeCell(code, e)} | ${cell(severityCell(code, e), withAnchors)} | ${cell(e.meaning, withAnchors)} | ${cell(e.fix, withAnchors)} |`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}

function renderDocsBlock(): string {
  return `${START}\n\n${renderTables(true)}\n\n${END}`;
}

/** Escape markdown for a TypeScript template literal. */
function templateEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function renderKnowledgeModule(): string {
  return [
    '// GENERATED from source/cli/src/utils/issue-code-registry.ts — do not edit by hand.',
    '// Edit the registry, then run `npm run codes:update` in source/cli.',
    '// The knowledge cli-reference topic interpolates this table.',
    '',
    `export const ISSUE_CODES_TABLE = \`${templateEscape(renderTables(false))}\n\`;`,
    '',
  ].join('\n');
}

/** The codes listed in the first column of every `Code`-headed table in `text`. */
function documentedCodes(text: string): string[] {
  const out: string[] = [];
  let inCodeTable = false;
  for (const line of text.split('\n')) {
    const row = /^\s*\|(.*)\|\s*$/.exec(line);
    if (row === null) {
      inCodeTable = false;
      continue;
    }
    const first = row[1].split(/(?<!\\)\|/)[0].trim();
    if (/^-+$/.test(first.replace(/:/g, ''))) continue;
    if (/^(?:\\?`)?Code(?:\\?`)?$/i.test(first)) {
      inCodeTable = true;
      continue;
    }
    if (!inCodeTable) continue;
    const token = /^\\?`([a-z0-9-]+)\\?`/.exec(first);
    if (token !== null) out.push(token[1]);
  }
  return out;
}

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
    if (UPDATE && current !== rendered) writeFileSync(DOCS_PAGE, page.slice(0, start) + rendered + page.slice(end + END.length));
    expect(readFileSync(DOCS_PAGE, 'utf-8').slice(start, start + rendered.length), 'the docs code tables differ from the registry — run npm run codes:update in source/cli').toBe(rendered);
  });

  it('the knowledge cli-reference topic interpolates the rendered tables', () => {
    const rendered = renderKnowledgeModule();
    if (UPDATE) writeFileSync(KNOWLEDGE_TABLE, rendered);
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
          for (const m of readFileSync(full, 'utf-8').matchAll(/\bcode: '([a-z][a-z0-9]*(?:-[a-z0-9]+)+)'/g)) {
            if (!registered.has(m[1]) && !internal.has(m[1])) unregistered.push(`${path.relative(CLI_ROOT, full)}: ${m[1]}`);
          }
        }
      }
    };
    walk(path.join(CLI_ROOT, 'src'));
    expect(unregistered).toEqual([]);
  });
});
