// =============================================================================
// The knowledge cli-reference topic, rendered from the docs page.
//
// docs/cli-reference.md is the one hand-written CLI reference. The knowledge
// topic an agent reads (`yg knowledge read cli-reference`) is that page, turned
// into what a terminal reader can use: the site's front matter, heading anchors,
// generated-block markers and custom containers go; a link to another page of
// the site becomes its text followed by the page's address; an HTML entity the
// site needs becomes its character. The page's issue-code tables are left out
// and the topic interpolates its own rendering of the registry in their place
// (templates/knowledge/issue-codes-table.ts), so the module this renders holds
// the text before those tables and the text after them.
//
// Pure: takes the page's text, returns the module's text. The guard
// (tests/unit/repo/knowledge-cli-reference.test.ts) compares the committed
// module with it; `npm run cli-reference:update` writes it.
// =============================================================================

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(__dirname, '..', '..');
export const KNOWLEDGE_CLI_REFERENCE_PAGE = path.join(CLI_ROOT, 'src', 'templates', 'knowledge', 'cli-reference-page.ts');

/** Where the docs site is published: a link to another page of it becomes this address. */
export const DOCS_SITE = 'https://krzysztofdudek.github.io/Yggdrasil';

const CODES_START = /<!-- issue-codes:start[^>]*-->/;
const CODES_END = '<!-- issue-codes:end -->';

/** A link as a terminal reader can follow it: its text, then where it points unless that is this page. */
function link(text: string, target: string): string {
  if (target.startsWith('#') || /^\/cli-reference(?:#|$)/.test(target)) return text;
  if (target.startsWith('/')) return `${text} (${DOCS_SITE}${target})`;
  return `${text} (${target})`;
}

/** The page's markdown as the topic carries it. */
function forTerminal(markdown: string): string {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const raw of markdown.split('\n')) {
    const opener = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (fence !== null) {
      if (opener !== null && opener[1][0] === fence[0] && raw.trim() === opener[1]) fence = null;
      lines.push(raw);
      continue;
    }
    if (opener !== null) {
      fence = opener[1];
      lines.push(raw);
      continue;
    }
    if (/^\s*<!--.*-->\s*$/.test(raw)) continue; // a generated block's marker
    if (/^:::/.test(raw)) continue; // a custom container's fence
    lines.push(
      raw
        .replace(/^(#{1,6} .*?)\s*\{#[\w-]+\}\s*$/, '$1')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, target: string) => link(text, target))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#123;/g, '{')
        .replace(/&amp;/g, '&'),
    );
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Escape markdown for a TypeScript template literal. */
function templateEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/** The module templates/knowledge/cli-reference-page.ts, rendered from the docs page's text. */
export function renderKnowledgeCliReference(page: string): string {
  const body = page.replace(/^---\n[\s\S]*?\n---\n/, '');
  const start = CODES_START.exec(body);
  const end = body.indexOf(CODES_END);
  if (start === null || end < start.index) throw new Error('docs/cli-reference.md has no issue-codes start and end markers');
  const before = `# CLI reference\n\nThis topic is the docs page ${DOCS_SITE}/cli-reference, rendered for the terminal.\n\n${forTerminal(body.slice(0, start.index)).trim()}\n\n`;
  const after = `\n${forTerminal(body.slice(end + CODES_END.length)).trimEnd()}\n`;
  return [
    '// GENERATED from docs/cli-reference.md — do not edit by hand.',
    '// Edit the docs page, then run `npm run cli-reference:update` in source/cli.',
    '// The knowledge cli-reference topic is this text around the issue-code tables.',
    '',
    `export const CLI_REFERENCE_BEFORE_CODES = \`${templateEscape(before)}\`;`,
    '',
    `export const CLI_REFERENCE_AFTER_CODES = \`${templateEscape(after)}\`;`,
    '',
  ].join('\n');
}
