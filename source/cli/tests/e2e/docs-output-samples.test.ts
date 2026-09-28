import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { runGitFixture } from '../support/git-fixture.js';
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
  runGitFixture(cwd, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args]);
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
  it('the first check after yg init (getting-started)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-sample-first-'));
    try {
      mkdirSync(path.join(dir, 'src'));
      for (let i = 1; i <= 49; i++) writeFileSync(path.join(dir, 'src', `f${i}.ts`), 'export const x = 1;\n');
      writeFileSync(path.join(dir, 'package.json'), '{}\n');
      git(['init', '-q'], dir);
      expect(yg(['init', '--no-reviewer'], dir).status).toBe(0);
      git(['add', '-A'], dir);
      const live = yg(['check'], dir).stdout.trimEnd();
      const marker = 'yg check: PASS  1 warning   0 nodes · 0/50 files covered · 4 excluded';
      expect(live).toContain(marker);
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
      expect(live).toContain('  fix:  yg check --approve  (1 reviewer pair · 1 call · paid)');
      expect(live).not.toMatch(/^next:/m);
      const gs = doc('docs/getting-started.md');
      expect(textBlockContaining(gs, header)).toBe(live);
      // The same one-component project renders the same file counts on every page.
      const counts = header.slice(header.indexOf('1 node · '));
      expect(counts).toBe('1 node · 1/1 file covered · 4 excluded');
      for (const page of ['docs/getting-started.md', 'docs/reviewers.md']) {
        for (const line of doc(page).split('\n').filter((l) => /^yg check: (PASS|FAIL) {2}.*1 node · /.test(l))) {
          expect(line, page).toContain(counts);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a cached refusal (README, reviewers, getting-started) matches examples/failing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-sample-refusal-'));
    try {
      cpSync(path.join(REPO_ROOT, 'examples', 'failing'), dir, { recursive: true });
      const live = yg(['check'], dir).stdout;
      // The README shows the report replayed from the committed lock, trimmed after the fix: heading (it says so).
      const shownRefusal = textBlockContaining(doc('README.md'), 'error[refused] requires-audit — refused on payments');
      expect(shownRefusal).toContain('  fix:  Four exits');
      expect(live.startsWith(shownRefusal), live).toBe(true);
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

  it('a changed file voids the recorded verdict (README) in examples/failing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-sample-voided-'));
    try {
      cpSync(path.join(REPO_ROOT, 'examples', 'failing'), dir, { recursive: true });
      const file = path.join(dir, 'src', 'payments.ts');
      writeFileSync(file, readFileSync(file, 'utf-8') + '\n');
      const live = yg(['check'], dir).stdout.trimEnd();
      expect(textBlockContaining(doc('README.md'), 'error[unverified] 1 pair whose inputs changed since the verdict')).toBe(live);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a live boundary refusal (README) in examples/layered-architecture', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-sample-boundary-'));
    try {
      cpSync(path.join(REPO_ROOT, 'examples', 'layered-architecture'), dir, { recursive: true });
      // The README's one-line edit: the web layer imports the data layer, under the existing import.
      const file = path.join(dir, 'src', 'web', 'rideHandler.ts');
      const lines = readFileSync(file, 'utf-8').split('\n');
      const at = lines.findIndex((l) => l.startsWith('import '));
      expect(at, 'rideHandler.ts has an import to add under').toBeGreaterThan(-1);
      lines.splice(at + 1, 0, "import { findRide } from '../data/rideRepository.js';");
      writeFileSync(file, lines.join('\n'));
      const live = yg(['check'], dir).stdout.trimEnd();
      // The README shows the whole report, fix: and next: included.
      const shown = textBlockContaining(doc('README.md'), "error[relation-undeclared-dependency] Node 'web'");
      expect(shown).toContain('src/web/rideHandler.ts:5 → data');
      expect(shown).toBe(live);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('the first free rule in a fresh repo (README quickstart): the API may not import the database', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-sample-quickstart-'));
    try {
      mkdirSync(path.join(dir, 'src', 'api'), { recursive: true });
      mkdirSync(path.join(dir, 'src', 'db'), { recursive: true });
      writeFileSync(path.join(dir, 'src', 'db', 'client.ts'), 'export function query(sql: string) { return sql; }\n');
      writeFileSync(path.join(dir, 'src', 'api', 'orders.ts'), "import { query } from '../db/client';\n\nexport function listOrders() {\n  return query('select * from orders');\n}\n");
      git(['init', '-q'], dir);
      expect(yg(['init', '--no-reviewer'], dir).status).toBe(0);
      const ygg = path.join(dir, '.yggdrasil');
      // What the agent writes for "the API layer must never import the database module":
      // two component types with no allowed relation between them, and one component each.
      writeFileSync(path.join(ygg, 'yg-architecture.yaml'), 'node_types:\n  api:\n    description: "HTTP handlers"\n    when:\n      path: "src/api/**"\n    relations:\n      default: deny\n  db:\n    description: "Database access"\n    when:\n      path: "src/db/**"\n    relations:\n      default: deny\n');
      mkdirSync(path.join(ygg, 'model', 'api'), { recursive: true });
      mkdirSync(path.join(ygg, 'model', 'db'), { recursive: true });
      writeFileSync(path.join(ygg, 'model', 'api', 'yg-node.yaml'), 'name: API\ntype: api\ndescription: HTTP handlers\nmapping:\n  - src/api/\n');
      writeFileSync(path.join(ygg, 'model', 'db', 'yg-node.yaml'), 'name: Database\ntype: db\ndescription: Database access\nmapping:\n  - src/db/\n');
      git(['add', '-A'], dir);
      const live = yg(['check'], dir).stdout.trimEnd();
      // The README trims the report after the at: block (it says so), so it must be a prefix of the live run.
      const shown = textBlockContaining(doc('README.md'), "error[relation-undeclared-dependency] Node 'api'");
      expect(shown).toContain('src/api/orders.ts:1 → db');
      expect(live.startsWith(shown), live).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
