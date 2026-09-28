// =============================================================================
// GUARD — the knowledge cli-reference topic is the docs page, rendered.
//
// docs/cli-reference.md is the one hand-written CLI reference. The topic an
// agent reads, `yg knowledge read cli-reference`, is generated from it
// (templates/knowledge/cli-reference-page.ts, by the renderer in
// tests/support/cli-reference-knowledge.ts) around the issue-code tables the
// topic renders from the registry, so a behaviour change written into the docs
// page reaches the agent too, and the topic cannot say something the page does
// not. This test renders the module from the page and fails on any difference;
// `npm run cli-reference:update` in source/cli rewrites it. It only reads.
//
// Hermetic & fast: reads two files and imports the knowledge module.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { KNOWLEDGE_TOPICS } from '../../../src/templates/knowledge/index.js';
import { ISSUE_CODES_TABLE } from '../../../src/templates/knowledge/issue-codes-table.js';
import { CLI_REFERENCE_AFTER_CODES, CLI_REFERENCE_BEFORE_CODES } from '../../../src/templates/knowledge/cli-reference-page.js';
import { KNOWLEDGE_CLI_REFERENCE_PAGE, renderKnowledgeCliReference } from '../../support/cli-reference-knowledge.js';
import { DOCS_PAGE } from './issue-code-render.js';

describe('the knowledge cli-reference topic is rendered from docs/cli-reference.md', () => {
  it('the committed module is what the docs page renders to', () => {
    const rendered = renderKnowledgeCliReference(readFileSync(DOCS_PAGE, 'utf-8'));
    expect(readFileSync(KNOWLEDGE_CLI_REFERENCE_PAGE, 'utf-8'), 'the knowledge cli-reference topic differs from docs/cli-reference.md — run npm run cli-reference:update in source/cli').toBe(rendered);
  });

  it('the topic is the rendered page around the registry\'s issue-code tables, and nothing else', () => {
    expect(KNOWLEDGE_TOPICS['cli-reference'].content).toBe(`${CLI_REFERENCE_BEFORE_CODES}${ISSUE_CODES_TABLE}${CLI_REFERENCE_AFTER_CODES}`);
  });

  it('renders for a terminal: no front matter, anchors, markers, containers or site-relative links', () => {
    const out = renderKnowledgeCliReference(
      [
        '---',
        'title: CLI Reference',
        '---',
        '',
        '## Setup {#setup}',
        '',
        '<!-- flags: yg init -->',
        '| `--x` | Set &lt;n&gt; |',
        '<!-- /flags -->',
        '',
        '::: tip',
        'See [Configuration](/configuration#tiers), [below](#setup) and [npm](https://www.npmjs.com/).',
        ':::',
        '',
        '```text',
        '<!-- kept inside a fence -->',
        '```',
        '<!-- issue-codes:start — generated -->',
        '| Code |',
        '<!-- issue-codes:end -->',
        '',
        'After the tables, `${x}`.',
      ].join('\n'),
    );
    expect(out).not.toContain('title: CLI Reference');
    expect(out).toContain('## Setup\n');
    expect(out).not.toContain('{#setup}');
    expect(out).not.toContain('<!-- flags');
    expect(out).not.toContain(':::');
    expect(out).toContain('Set <n>');
    expect(out).toContain('See Configuration (https://krzysztofdudek.github.io/Yggdrasil/configuration#tiers), below and npm (https://www.npmjs.com/).');
    expect(out).toContain('<!-- kept inside a fence -->');
    expect(out).not.toContain('| Code |');
    expect(out).toContain('After the tables, \\`\\${x}\\`.');
  });
});
