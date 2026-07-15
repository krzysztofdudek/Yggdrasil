import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// End-to-end regression for the `docs-internal-links` deterministic aspect through
// the PUBLIC CLI surface (`yg aspect-test --files`). The drill corpus excludes .md
// files and runs one file per case, so a multi-file link resolver cannot be drilled;
// this fixture-based e2e is its regression vehicle (recorded in the M3 DRILL_EXEMPT
// reason). Fixtures are real on-disk .md files — no mocking.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '../../../..'); // the graph with the aspect lives here
const BIN_PATH = path.join(REPO_ROOT, 'source', 'cli', 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

let dir: string;
const F = (name: string, body: string): string => {
  const p = path.join(dir, name);
  writeFileSync(p, body, 'utf-8');
  return p;
};

/** Run `yg aspect-test --aspect docs-internal-links --files <paths>` from the repo root. */
function checkLinks(files: string[]): { stdout: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, 'aspect-test', '--aspect', 'docs-internal-links', '--files', ...files], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  return { stdout: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'yg-docs-links-'));
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!distExists)('docs-internal-links — e2e over real .md fixtures', () => {
  it('cross-page links that resolve to existing pages pass', () => {
    const a = F('a.md', '# A\nSee [B](/b) and the [relative form](./b.md#part).\n');
    const b = F('b.md', '# B\nBack to [A](/a) and [home](/).\n');
    const home = F('index.md', '# Home\nGo to [A](/a).\n');
    const out = checkLinks([a, b, home]).stdout;
    expect(out).toContain('satisfied');
    expect(out).not.toContain('refused');
  });

  it('a genuinely broken internal link is refused and named with its line', () => {
    const a = F('a.md', '# A\nGood: [B](/b).\nBroken: [gone](/this-page-does-not-exist).\n');
    const b = F('b.md', '# B\n');
    const { stdout, status } = checkLinks([a, b]);
    expect(stdout).toContain('refused');
    expect(stdout).toContain('/this-page-does-not-exist');
    expect(stdout).toMatch(/L3/); // the broken link is on line 3
    expect(status).not.toBe(0);
  });

  it('reports every broken link, not just the first', () => {
    const a = F('a.md', '# A\n[x](/nope-one) then [y](/nope-two).\n');
    const b = F('b.md', '# B\n');
    const out = checkLinks([a, b]).stdout;
    expect(out).toContain('/nope-one');
    expect(out).toContain('/nope-two');
  });

  it('skips every non-page construct (zero false positives) — the adversarial battery', () => {
    // Each link/target below MUST be skipped or resolved, never flagged: titled
    // links, angle-bracket + title, root, index alias, weird-extension and
    // extensionless images, .html/.gif/.SVG assets, external + mailto, anchors,
    // escaped brackets, inline code (single and double backtick), balanced parens,
    // fenced (``` and ~~~) and indented code blocks.
    const home = F('index.md', [
      '---',
      'title: Home',
      '---',
      'Titled: [S](/settings "The Settings Page"). Angle+title: [x](</settings> "Config").',
      'Root: [Home](/). Index alias: [idx](/index).',
      'Images: ![arch](/diagram.jpeg) ![logo](/brand/logo) ![up](/L.SVG).',
      'Assets: [demo](/demo.html) [g](/pic.gif) [css](/theme.css).',
      'External: [site](https://example.com) [mail](mailto:a@b.com).',
      'Anchors: [top](#home) [q](/settings?tab=1#x).',
      'Escaped (not a link): \\[nope\\](/escaped-nonexistent).',
      'Inline code: ``[x](/code-broken)`` and `[y](/also-code-broken)`.',
      'Parens: [d](/page_(disambiguation)).',
      '```md',
      'Fenced example: [z](/fenced-broken).',
      '~~~',
      '[nested](/nested-fenced-broken).',
      '~~~',
      '```',
      '',
      '    Indented code: [w](/indented-broken).',
      '',
    ].join('\n'));
    const settings = F('settings.md', '# Settings\nBack to [home](/index).\n');
    const out = checkLinks([home, settings]).stdout;
    expect(out).toContain('satisfied');
    expect(out).not.toContain('refused');
  });

  it('resolves a real repo doc set clean (no broken links ship)', () => {
    // The actual adopter docs must have zero broken internal links.
    const docsDir = path.join(REPO_ROOT, 'docs');
    const realDocs = spawnSync(
      'node',
      ['-e', `const fs=require('fs'),p=require('path');const out=[];(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){if(e.name==='node_modules'||e.name==='.vitepress')continue;const f=p.join(d,e.name);if(e.isDirectory())w(f);else if(e.name.endsWith('.md'))out.push(f);}})(${JSON.stringify(docsDir)});process.stdout.write(out.join('\\n'));`],
      { encoding: 'utf-8' },
    ).stdout.trim().split('\n').filter(Boolean);
    expect(realDocs.length).toBeGreaterThan(10);
    const out = checkLinks(realDocs).stdout;
    expect(out).toContain('satisfied');
  });
});
