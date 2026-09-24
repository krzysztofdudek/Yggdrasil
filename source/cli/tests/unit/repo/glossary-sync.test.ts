// =============================================================================
// GUARD — the docs Glossary page and the portal read one glossary.
//
// The words Yggdrasil uses are defined once, in the portal's glossary module
// (templates/portal/js/glossary.js): its entries are the portal's tooltips and
// the honest-state legend's explanations. docs/glossary.md is generated from the
// same entries, so the site and the portal cannot drift. This test renders the
// page from the module and fails on any difference; with YG_GLOSSARY_UPDATE=1
// (npm run glossary:update) it rewrites the page instead.
//
// Hermetic & fast: evaluates the browser module in a vm sandbox; spawns nothing.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(__dirname, '..', '..', '..');
const REPO_ROOT = path.resolve(CLI_ROOT, '..', '..');
const MODULE_PATH = path.join(CLI_ROOT, 'src', 'templates', 'portal', 'js', 'glossary.js');
const PAGE_PATH = path.join(REPO_ROOT, 'docs', 'glossary.md');

interface Entry {
  id: string;
  term: string;
  group: string;
  def: string;
  not?: string;
  see?: string;
}

interface Glossary {
  entries: Entry[];
  lookup: (id: string) => string | null;
}

function loadGlossary(): Glossary {
  const window: Record<string, unknown> = {};
  vm.runInNewContext(readFileSync(MODULE_PATH, 'utf-8'), { window });
  return (window.YgPortal as { glossary: Glossary }).glossary;
}

/** The title of a docs page — its name in the docs sidebar. */
function pageTitle(link: string): string {
  const page = link.split('#')[0];
  const config = readFileSync(path.join(REPO_ROOT, 'docs', '.vitepress', 'config.ts'), 'utf-8');
  const m = new RegExp(`\\{ text: "([^"]+)", link: "${page}" \\}`).exec(config);
  expect(m, `${page} is not in the docs sidebar`).not.toBeNull();
  return m![1];
}

/** The anchors a docs page offers — VitePress's heading slugs, or an explicit {#id}. */
function anchors(page: string): Set<string> {
  const text = readFileSync(path.join(REPO_ROOT, 'docs', `${page.replace(/^\//, '')}.md`), 'utf-8');
  const out = new Set<string>();
  let fenced = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    const h = fenced ? null : /^#{1,6} (.*)$/.exec(line);
    if (!h) continue;
    const explicit = /\{#([^}]+)\}\s*$/.exec(h[1]);
    if (explicit) {
      out.add(explicit[1]);
      continue;
    }
    out.add(
      h[1]
        .normalize('NFKD')
        .replace(/[\u0300-\u036F]/g, '')
        .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/^(\d)/, '_$1')
        .toLowerCase(),
    );
  }
  return out;
}

function render(entries: Entry[]): string {
  const out: string[] = [
    '# Glossary',
    '',
    '<!-- Generated from source/cli/src/templates/portal/js/glossary.js, which the portal also reads for its tooltips. Edit the entries there, then run `npm run glossary:update` in source/cli. -->',
    '',
    'Each word here has one meaning, the same in these docs, in `yg prime`, in `yg knowledge`, in the CLI output and in the portal. Where an older word meant the same thing, it is listed as not used, so you can map it when you meet it in an old note.',
  ];
  let group = '';
  for (const e of entries) {
    if (e.group !== group) {
      group = e.group;
      out.push('', `## ${group}`);
    }
    out.push('', `### ${e.term} {#${e.id}}`, '', e.def);
    const extra: string[] = [];
    if (e.not) extra.push(`Not called: ${e.not}.`);
    if (e.see) extra.push(`More: [${pageTitle(e.see)}](${e.see}).`);
    if (extra.length > 0) out.push('', extra.join(' '));
  }
  return out.join('\n') + '\n';
}

describe('the docs Glossary page and the portal glossary agree', () => {
  const glossary = loadGlossary();

  it('every entry is complete and its id is unique', () => {
    const ids = new Set<string>();
    for (const e of glossary.entries) {
      expect(e.id, `entry ${e.term}`).toMatch(/^[a-z][a-z-]*$/);
      expect(ids.has(e.id), `duplicate id ${e.id}`).toBe(false);
      ids.add(e.id);
      expect(e.term && e.group && e.def, `entry ${e.id}`).toBeTruthy();
      if (!e.see) continue;
      const [page, anchor] = e.see.split('#');
      expect(existsSync(path.join(REPO_ROOT, 'docs', `${page.replace(/^\//, '')}.md`)), `${e.id} see ${e.see}`).toBe(true);
      if (anchor) expect([...anchors(page)], `${e.id} links to a heading that does not exist: ${e.see}`).toContain(anchor);
    }
  });

  it('a tooltip is the entry text without code marks', () => {
    for (const e of glossary.entries) expect(glossary.lookup(e.id)).toBe(e.def.replace(/`/g, ''));
  });

  it('docs/glossary.md is generated from the portal glossary', () => {
    const page = render(glossary.entries);
    if (process.env.YG_GLOSSARY_UPDATE === '1') writeFileSync(PAGE_PATH, page);
    expect(existsSync(PAGE_PATH), 'docs/glossary.md is missing — run npm run glossary:update in source/cli').toBe(true);
    expect(readFileSync(PAGE_PATH, 'utf-8'), 'docs/glossary.md differs from glossary.js — run npm run glossary:update in source/cli').toBe(page);
  });

  it('the Glossary page is in the docs sidebar under Start here', () => {
    const config = readFileSync(path.join(REPO_ROOT, 'docs', '.vitepress', 'config.ts'), 'utf-8');
    const start = config.indexOf('text: "Start here"');
    const next = config.indexOf('text: "Core concepts"');
    expect(start).toBeGreaterThan(-1);
    expect(config.slice(start, next)).toContain('link: "/glossary"');
  });
});
