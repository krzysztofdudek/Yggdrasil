import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Public-surface E2E for `yg portal --static`. Spawns the built dist/bin.js against a REAL
// fixture project (a real .yggdrasil/ graph + real source) and asserts the emitted page is
// a single self-contained offline file. No src/** import (e2e-public-surface aspect): the
// only inputs are the spawned CLI and the committed file it wrote.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE_ROOT = path.join(CLI_ROOT, 'tests', 'fixtures', 'portal-basic');

const distExists = existsSync(BIN_PATH);

/**
 * The executable/markup network references an offline page must never carry. Asserted against
 * the EXECUTABLE SURFACE only (the inlined application/json data region stripped first).
 */
const LOADABLE = [
  /<script[^>]*\ssrc\s*=/i,
  /<link[^>]*\shref\s*=\s*["'](?:https?:)?\/\//i,
  /\bsrc\s*=\s*["'](?:https?:)?\/\//i,
  /url\(\s*["']?(?:https?:)?\/\//i,
  /\bfetch\s*\(/i,
  /\bnew\s+(?:WebSocket|XMLHttpRequest|EventSource)\b/i,
  /\b(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh|skypack\.dev|googleapis\.com|gstatic\.com)\b/i,
] as const;

/**
 * Strip the inlined `<script id="portal-data" type="application/json">…</script>` DATA region,
 * returning the executable/markup surface (inlined JS modules + HTML/CSS). The JSON is inert
 * payload the browser never executes and can legitimately contain URLs / "fetch(" from the graph,
 * so it must be excluded from the offline proof. The strict-guard test proves a real network
 * reference on the remaining surface is still caught.
 */
function stripDataRegion(html: string): string {
  return html.replace(
    /<script id="portal-data" type="application\/json">[\s\S]*?<\/script>/g,
    '<script id="portal-data" type="application/json"></script>',
  );
}

const tmpDirs: string[] = [];

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function runPortalStatic(outPath: string): { stdout: string; stderr: string; status: number | null } {
  // --open is NOT passed: no browser is ever launched in a test.
  const result = spawnSync('node', [BIN_PATH, 'portal', '--static', '--out', outPath], {
    cwd: FIXTURE_ROOT,
    encoding: 'utf-8',
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

describe.skipIf(!distExists)('CLI E2E — yg portal --static (self-contained offline emit)', () => {
  let html: string;
  let outPath: string;
  let runStatus: number | null;
  let runStdout: string;

  beforeAll(() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-portal-e2e-'));
    tmpDirs.push(dir);
    outPath = path.join(dir, 'portal.html');
    const run = runPortalStatic(outPath);
    runStatus = run.status;
    runStdout = run.stdout;
    html = existsSync(outPath) ? readFileSync(outPath, 'utf-8') : '';
  });

  it('exits 0 and prints the written path', () => {
    expect(runStatus).toBe(0);
    expect(runStdout).toContain(outPath);
    expect(existsSync(outPath)).toBe(true);
  });

  it('emitted a single self-contained HTML document', () => {
    expect(html.trimStart().toLowerCase().startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
    expect((html.match(/<script id="portal-data" type="application\/json">/g) ?? []).length).toBe(1);
  });

  it('inlined the real fixture PortalData (no fabricated data) which round-trips', () => {
    const m = html.match(/<script id="portal-data" type="application\/json">([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    const data = JSON.parse((m as RegExpMatchArray)[1]);
    expect(data.meta.counts.nodes).toBe(3);
    const paths = data.nodes.map((n: { path: string }) => n.path);
    expect(paths).toContain('api/orders');
    expect(paths).toContain('api/users');
  });

  it('has no externally-loadable network / CDN reference on the executable surface (fully offline)', () => {
    // Scan ONLY the executable/markup surface — the inlined JS modules + HTML/CSS — with the
    // inlined application/json PortalData region PARSED OUT first. The real graph data (node
    // descriptions, source snippets, rule prose) can legitimately contain "fetch(", a URL, or
    // "url("; that JSON is inert payload the browser never executes, so greping it would
    // false-positive. The proof stays strict on the surface that actually runs.
    const surface = stripDataRegion(html);
    for (const re of LOADABLE) {
      expect(surface, `offline violation on executable surface: ${re}`).not.toMatch(re);
    }
  });

  it('the offline proof is strict: a genuine network reference on the code surface still fails', () => {
    // Guard the guard. Injecting a real <script src=http> + fetch('http…') into the EXECUTABLE
    // surface (outside the JSON data region) must still be caught after the strip — proving the
    // parse-out did not blind the assertion. The same strings inside the JSON payload are ignored.
    const tampered = html.replace(
      '</body>',
      '<script src="https://cdn.jsdelivr.net/x.js"></script><script>fetch("https://evil.example/x")</script></body>',
    );
    const surface = stripDataRegion(tampered);
    expect(surface).toMatch(/<script[^>]*\ssrc\s*=/i);
    expect(surface).toMatch(/\bfetch\s*\(/i);
    // A fetch( that exists ONLY inside the JSON data region is correctly NOT on the surface.
    const fetchInData = html.replace(
      /<script id="portal-data" type="application\/json">/,
      '<script id="portal-data" type="application/json">{"x":"fetch(https://api.example/y)"}',
    );
    expect(fetchInData).toMatch(/fetch\(/); // present somewhere (inside the JSON)
    expect(stripDataRegion(fetchInData)).not.toMatch(/\bfetch\s*\(/i); // but NOT on the executable surface
  });

  it('inlined the vendored layout library', () => {
    expect(html).toContain('d3.hierarchy');
  });

  it('lists the loopback server + static options on --help (server covered by the server E2E)', () => {
    // Plain `yg portal` now starts a foreground loopback server (covered end-to-end in
    // cli-portal-server.test.ts); spawning it here would block, so we assert the option
    // surface instead — --static and the server flags are all present and documented.
    const result = spawnSync('node', [BIN_PATH, 'portal', '--help'], { cwd: FIXTURE_ROOT, encoding: 'utf-8' });
    expect(result.status).toBe(0);
    const help = (result.stdout ?? '') + (result.stderr ?? '');
    expect(help).toMatch(/--static/);
    expect(help).toMatch(/--port/);
    expect(help).toMatch(/--no-write/);
  });
});

// Public-surface E2E: the portal's live suppression inventory (embedded in the static
// payload the extraction pipeline emits) must reach every file a `yg-suppress` marker is
// actually honored in — not only an ordinary git-tracked-file walk. Three files, two real
// aspects (tests/fixtures/type-level-engine merged with its binary-subject variant): a
// type-covered file with no owning component (src/pics/readme.md, aspect prose-rule — a
// `.md` subject, so listing it actually depends on the type-coverage exemption reaching
// the noise filter, unlike a `.ts` subject that was never noise to begin with), and two
// files the real 'owned' node maps directly, both carrying own-file-rule — one under
// `.yggdrasil/` (pruned from the coverage walk) and one a `.gitignore` excludes (an exact
// mapping entry is reviewed regardless of ignore status). The deterministic runner honors
// a marker on all three; the portal's read-only inventory (engine-api.ts's
// scanPortalSuppressions, feeding extract.ts) must list all three too, or an operator
// reading the portal sees a clean waiver surface that is not.
const TYPE_LEVEL_FIXTURE_ROOT = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-level-engine');

describe.skipIf(!distExists)('CLI E2E — yg portal --static lists a marker wherever it is honored, whatever file hosts it', () => {
  it('the embedded suppression inventory names the type-covered file, the .yggdrasil/-mapped file, and the gitignored mapped file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-portal-typelevel-'));
    try {
      cpSync(TYPE_LEVEL_FIXTURE_ROOT, dir, { recursive: true });
      cpSync(path.join(TYPE_LEVEL_FIXTURE_ROOT, 'variants', 'binary-subject'), dir, { recursive: true });

      const nodeYamlPath = path.join(dir, '.yggdrasil', 'model', 'owned', 'yg-node.yaml');
      const original = readFileSync(nodeYamlPath, 'utf-8');
      const updated = original.replace(
        'mapping:\n  - src/owned/o.ts\n',
        'mapping:\n  - src/owned/o.ts\n  - .yggdrasil/meta/notes.md\n  - generated/g.ts\n',
      );
      expect(updated).not.toBe(original);
      writeFileSync(nodeYamlPath, updated);

      mkdirSync(path.join(dir, '.yggdrasil', 'meta'), { recursive: true });
      writeFileSync(
        path.join(dir, '.yggdrasil', 'meta', 'notes.md'),
        '# design notes\n\n<!-- yg-suppress(own-file-rule) portal waiver under dot-yggdrasil -->\n',
      );

      writeFileSync(path.join(dir, '.gitignore'), 'generated/\n');
      mkdirSync(path.join(dir, 'generated'), { recursive: true });
      writeFileSync(
        path.join(dir, 'generated', 'g.ts'),
        'export const G = 1;\n// yg-suppress(own-file-rule) portal waiver on a gitignored file\n',
      );

      appendFileSync(
        path.join(dir, 'src', 'pics', 'readme.md'),
        '\n<!-- yg-suppress(prose-rule) portal waiver on a type-covered file -->\n',
      );

      const outPath = path.join(dir, 'portal.html');
      const result = spawnSync('node', [BIN_PATH, 'portal', '--static', '--out', outPath], {
        cwd: dir,
        encoding: 'utf-8',
      });
      expect(result.status).toBe(0);
      const out = readFileSync(outPath, 'utf-8');

      expect(out).toContain('portal waiver under dot-yggdrasil');
      expect(out).toContain('portal waiver on a gitignored file');
      expect(out).toContain('portal waiver on a type-covered file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
