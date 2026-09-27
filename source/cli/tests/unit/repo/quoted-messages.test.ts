// =============================================================================
// GUARD — a message the reference surfaces quote is one the CLI can print.
//
// The docs pages, the knowledge topics, the operating manual and the CHANGELOG's
// unreleased section quote the CLI's own words in code spans ("says `…` on
// stderr", "the header reads `…`"). A quote copied from an older build keeps
// reading as fact after the words change: the concurrency page said "Another
// approval is already running" long after the CLI said "Another fill is
// already running". This guard reads every string the shipped source spells
// (quoted-messages.ts) and fails on a quoted message with three words in a row
// the CLI cannot print.
//
// Hermetic & fast: parses the source with the TypeScript compiler, reads the
// pages, imports the knowledge and manual modules; spawns nothing.
// =============================================================================

import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { KNOWLEDGE_TOPICS } from '../../../src/templates/knowledge/index.js';
import { AGENT_RULES_CONTENT } from '../../../src/templates/rules.js';
import { CLI_ROOT, REPO_ROOT } from './issue-code-render.js';
import { misquotes, quotedMessages, vocabulary, type Misquote } from './quoted-messages.js';

const SRC = path.join(CLI_ROOT, 'src');

/** The reference texts in the source tree: they quote the CLI, they are not what it prints. */
const isReferenceText = (abs: string): boolean => {
  const rel = path.relative(SRC, abs).split(path.sep).join('/');
  return rel.startsWith('templates/knowledge/') || rel.startsWith('templates/schemas/') || rel === 'templates/rules.ts';
};

function unreleasedChangelog(): string {
  const text = readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf-8');
  const start = text.indexOf('## [Unreleased]');
  const end = text.indexOf('\n## [', start + 1);
  return start < 0 ? '' : text.slice(start, end < 0 ? undefined : end);
}

describe('every message a reference surface quotes is one the CLI can print', () => {
  let vocab: Set<string>;
  beforeAll(() => {
    vocab = vocabulary(SRC, isReferenceText);
  }, 60_000);

  it('reads the vocabulary from the source (the guard is wired up, not a no-op)', () => {
    expect(vocab.size).toBeGreaterThan(20_000);
    expect(vocab.has('another fill is')).toBe(true);
  });

  it('holds the docs pages, the knowledge topics, the manual and the unreleased CHANGELOG to it', () => {
    const docs = path.join(REPO_ROOT, 'docs');
    const surfaces: Array<[string, string]> = [
      ...readdirSync(docs).filter((n) => n.endsWith('.md')).map((f): [string, string] => [`docs/${f}`, readFileSync(path.join(docs, f), 'utf-8')]),
      ...Object.entries(KNOWLEDGE_TOPICS).map(([name, topic]): [string, string] => [`knowledge ${name}`, topic.content]),
      ['yg prime', AGENT_RULES_CONTENT],
      ['CHANGELOG.md [Unreleased]', unreleasedChangelog()],
    ];
    const quoted = surfaces.reduce((n, [, text]) => n + quotedMessages(text).length, 0);
    expect(quoted, 'the surfaces quote messages, so the guard reads some').toBeGreaterThan(20);
    const bad: Misquote[] = surfaces.flatMap(([where, text]) => misquotes(where, text, vocab));
    const report = bad.map((b) => `  ${b.where}:${b.line}  "${b.unknown}" in \`${b.quoted.slice(0, 140)}\``).join('\n');
    expect(bad, `a quoted message has words the CLI does not print — quote what the CLI prints now:\n${report}`).toEqual([]);
  });

  it('catches a quote whose words changed, and passes one over the counts and names the CLI fills in', () => {
    const drifted = 'A second run prints `error[lock-environment]: Another approval is already running in this repository` on stderr.';
    expect(misquotes('x.md', drifted, vocab).map((m) => m.unknown)).toEqual(['another approval is']);
    const current = 'The header reads `error[unverified] 3 pairs whose inputs changed since the verdict` for them.';
    expect(misquotes('x.md', current, vocab)).toEqual([]);
  });

  it('reads as a message only a code span a sentence introduces as output, and not code or a command', () => {
    expect(quotedMessages('It prints `the node has no mapping at all` here.').map((q) => q.quoted)).toEqual(['the node has no mapping at all']);
    expect(quotedMessages('Set `status: advisory when unsure` in the file.')).toEqual([]);
    expect(quotedMessages('The line reads `ctx.fs.read(path) returns text`.')).toEqual([]);
    expect(quotedMessages('It says to run `yg check --approve --only-deterministic` next.')).toEqual([]);
    expect(quotedMessages('```text\nIt prints `inside a fence`\n```')).toEqual([]);
    expect(quotedMessages('Its line now says `a` where it said `the old words of the line`.').map((q) => q.quoted)).toEqual([]);
  });
});
