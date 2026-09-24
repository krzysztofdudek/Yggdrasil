import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Output samples in the docs are copies of real terminal output, and copies
// drift. Each test here regenerates one sample from a real run and compares it
// with every page that shows it, so a change to the output fails until the
// pages are updated with it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const REPO_ROOT = path.join(CLI_ROOT, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

function yg(args: string[], cwd: string): { status: number | null; stdout: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout ?? '' };
}

function git(args: string[], cwd: string): void {
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf-8' });
}

function doc(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

/** The ```text block of a page that contains `marker`, without a leading `$ cmd` line. */
function textBlockContaining(page: string, marker: string): string {
  const at = page.indexOf(marker);
  expect(at, `sample marker not found: ${marker}`).toBeGreaterThan(-1);
  const start = page.lastIndexOf('```text\n', at) + '```text\n'.length;
  const end = page.indexOf('```', at);
  return page.slice(start, end).replace(/^\$ [^\n]*\n\n/, '').trimEnd();
}

describe.skipIf(!distExists)('docs output samples match the CLI', () => {
  it('the first check after yg init (README, getting-started)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-sample-first-'));
    try {
      mkdirSync(path.join(dir, 'src'));
      for (let i = 1; i <= 49; i++) writeFileSync(path.join(dir, 'src', `f${i}.ts`), 'export const x = 1;\n');
      writeFileSync(path.join(dir, 'package.json'), '{}\n');
      git(['init', '-q'], dir);
      expect(yg(['init', '--no-reviewer'], dir).status).toBe(0);
      git(['add', '-A'], dir);
      const live = yg(['check'], dir).stdout.trimEnd();
      const marker = 'yg check: PASS  1 warning   0 nodes · 4/54 files covered';
      expect(live).toContain(marker);
      expect(textBlockContaining(doc('README.md'), marker)).toBe(live);
      expect(textBlockContaining(doc('docs/getting-started.md'), marker)).toBe(live);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the first rule, unverified (getting-started), and the summary line it shares with reviewers', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-sample-rule-'));
    try {
      mkdirSync(path.join(dir, 'src', 'payments'), { recursive: true });
      writeFileSync(path.join(dir, 'src', 'payments', 'charge.ts'), 'export function chargeCard() { return 1; }\n');
      git(['init', '-q'], dir);
      expect(yg(['init', '--no-reviewer'], dir).status).toBe(0);
      const ygg = path.join(dir, '.yggdrasil');
      // The page assumes a reviewer is configured; an unreachable one is never called here.
      writeFileSync(path.join(ygg, 'yg-config.yaml'), readFileSync(path.join(ygg, 'yg-config.yaml'), 'utf-8') +
        'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: m\n        endpoint: http://127.0.0.1:1\n');
      writeFileSync(path.join(ygg, 'yg-architecture.yaml'), 'node_types:\n  module:\n    description: A payments module\n    when:\n      path: "src/payments/**"\n');
      mkdirSync(path.join(ygg, 'aspects', 'requires-audit'), { recursive: true });
      writeFileSync(path.join(ygg, 'aspects', 'requires-audit', 'yg-aspect.yaml'), 'name: Requires Audit\ndescription: "Every mutation emits an audit event"\nreviewer:\n  type: llm\n');
      writeFileSync(path.join(ygg, 'aspects', 'requires-audit', 'content.md'), '# Audit\nEvery mutation must call auditLog.emit().\n');
      mkdirSync(path.join(ygg, 'model', 'payments'), { recursive: true });
      writeFileSync(path.join(ygg, 'model', 'payments', 'yg-node.yaml'), 'name: Payments\ntype: module\ndescription: payments\nmapping:\n  - src/payments/\naspects:\n  - requires-audit\n');
      git(['add', '-A'], dir);
      const live = yg(['check'], dir).stdout.trimEnd();
      const header = live.split('\n')[0];
      expect(header).toMatch(/^yg check: FAIL {2}1 error {3}1 node · /);
      // The one block's fix IS the step, so no separate next: line repeats it.
      expect(live).toContain('  fix:  yg check --approve  (1 reviewer pair · paid — ask the user first)');
      expect(live).not.toMatch(/^next:/m);
      const gs = doc('docs/getting-started.md');
      expect(textBlockContaining(gs, header)).toBe(live);
      // The same one-component project renders the same file counts on every page.
      const counts = header.slice(header.indexOf('1 node · '));
      expect(counts).toBe('1 node · 5/5 files covered (1 node-owned · 4 excluded)');
      for (const page of ['docs/getting-started.md', 'docs/reviewers.md']) {
        for (const line of doc(page).split('\n').filter((l) => /^yg check: (PASS|FAIL) {2}.*1 node · /.test(l))) {
          expect(line, page).toContain(counts);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a cached refusal (reviewers, getting-started) matches examples/failing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-sample-refusal-'));
    try {
      cpSync(path.join(REPO_ROOT, 'examples', 'failing'), dir, { recursive: true });
      const live = yg(['check'], dir).stdout;
      // The block's fix: (heading line plus its four numbered exits) and the report's next: line.
      const fixAt = live.indexOf('  fix:  Four exits');
      expect(fixAt, live).toBeGreaterThan(-1);
      const fix = live.slice(fixAt, live.indexOf('\n\n', fixAt));
      expect(fix.split('\n')).toHaveLength(5);
      const next = live.slice(live.indexOf('\nnext: ') + 1).trimEnd();
      expect(next).toMatch(/^next: \S/);
      for (const page of ['docs/reviewers.md', 'docs/getting-started.md']) {
        expect(doc(page), page).toContain(fix);
        expect(doc(page), page).toContain(next);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the coverage stanza yg init --upgrade prints (getting-started, platforms, configuration)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-sample-stanza-'));
    try {
      git(['init', '-q'], dir);
      expect(yg(['init', '--no-reviewer'], dir).status).toBe(0);
      // A project from before require-nothing: no coverage block at all, and
      // none of the files init maintains at the root yet.
      const cfg = path.join(dir, '.yggdrasil', 'yg-config.yaml');
      writeFileSync(cfg, readFileSync(cfg, 'utf-8').replace(/^coverage:\n(?: {2}.*\n)+/m, ''));
      for (const f of ['AGENTS.md', 'CLAUDE.md', '.clinerules', '.gitattributes']) rmSync(path.join(dir, f), { recursive: true, force: true });
      const live = yg(['init', '--upgrade'], dir).stdout;
      // The stanza sits under the notice's next: line, indented as a block; its
      // own nesting (coverage: → excluded: → entries) must survive that indent.
      const start = live.search(/coverage:\n( *) {2}excluded:\n/);
      expect(start, live).toBeGreaterThan(-1);
      const stanza = live.slice(live.lastIndexOf('\n', start) + 1, live.indexOf('Or, if you would rather', start));
      const lines = stanza.split('\n');
      const base = (l: string): number => l.length - l.trimStart().length;
      expect(base(lines[1]) - base(lines[0]), stanza).toBe(2);
      expect(base(lines[2]) - base(lines[1]), stanza).toBe(2);
      const entries = stanza.split('\n').filter((l) => l.trim().startsWith('- ')).map((l) => l.trim());
      expect(entries).toEqual(['- AGENTS.md', '- CLAUDE.md', '- .clinerules/yggdrasil.md', '- .gitattributes']);
      for (const page of ['docs/getting-started.md', 'docs/platforms.md', 'docs/configuration.md']) {
        const text = doc(page);
        const at = text.indexOf('  excluded:\n', text.indexOf('- AGENTS.md') - 40);
        const shown = text.slice(at).split('\n').slice(1, 5).map((l) => l.trim());
        expect(shown, page).toEqual(entries);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
