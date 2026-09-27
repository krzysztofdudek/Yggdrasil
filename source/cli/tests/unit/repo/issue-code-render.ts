// The issue-code tables as rendered from the code registry, shared by the guard
// that compares the committed tables with them (issue-code-tables.test.ts) and
// the command that rewrites them (generated-files.update.ts, run by
// `npm run codes:update`). Reads nothing and writes nothing.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ISSUE_CODES, issueCodeEntry, type IssueCodeEntry, type IssueStage } from '../../../src/utils/issue-code-registry.js';
import { APPROVE_GATING_CODES, APPROVE_LOG_STATE_GATING_CODES, SCOPED_CODES } from '../../../src/utils/check-codes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CLI_ROOT = path.resolve(__dirname, '..', '..', '..');
export const REPO_ROOT = path.resolve(CLI_ROOT, '..', '..');
export const DOCS_PAGE = path.join(REPO_ROOT, 'docs', 'cli-reference.md');
export const KNOWLEDGE_DIR = path.join(CLI_ROOT, 'src', 'templates', 'knowledge');
export const KNOWLEDGE_TABLE = path.join(KNOWLEDGE_DIR, 'issue-codes-table.ts');

export const START = '<!-- issue-codes:start — generated from source/cli/src/utils/issue-code-registry.ts; edit the registry, then run npm run codes:update in source/cli -->';
export const END = '<!-- issue-codes:end -->';

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
  const heads = e.label !== undefined && e.label !== code ? ` (heads as \`${e.label}\`)` : '';
  const formerly = e.formerly !== undefined && e.formerly.length > 0 ? ` (formerly ${e.formerly.map((old) => `\`${old}\``).join(', ')})` : '';
  return `\`${code}\`${heads}${formerly}`;
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

export function renderDocsBlock(): string {
  return `${START}\n\n${renderTables(true)}\n\n${END}`;
}

/** Escape markdown for a TypeScript template literal. */
function templateEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

export function renderKnowledgeModule(): string {
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
export function documentedCodes(text: string): string[] {
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
