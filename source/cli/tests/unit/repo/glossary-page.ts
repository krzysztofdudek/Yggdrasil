// docs/glossary.md as rendered from the portal glossary module, shared by the
// guard that compares the committed page with it (glossary-sync.test.ts) and
// the command that rewrites the page (generated-files.update.ts, run by
// `npm run glossary:update`). Reads files only; writes nothing.

import { expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(__dirname, '..', '..', '..');
export const REPO_ROOT = path.resolve(CLI_ROOT, '..', '..');
const MODULE_DIR = path.join(CLI_ROOT, 'src', 'templates', 'portal', 'js');
export const PAGE_PATH = path.join(REPO_ROOT, 'docs', 'glossary.md');

export interface Entry {
  id: string;
  term: string;
  group: string;
  def: string;
  token?: string;
  not?: string;
  see?: string;
}

interface Glossary {
  entries: Entry[];
  lookup: (id: string) => string | null;
}

export function loadGlossary(): Glossary {
  const window: Record<string, unknown> = {};
  const context = vm.createContext({ window });
  for (const f of ['glossary-entries.js', 'glossary-entries-rest.js', 'glossary.js']) vm.runInContext(readFileSync(path.join(MODULE_DIR, f), 'utf-8'), context);
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
export function anchors(page: string): Set<string> {
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

export function render(entries: Entry[]): string {
  const out: string[] = [
    '# Glossary',
    '',
    '<!-- Generated from source/cli/src/templates/portal/js/glossary-entries.js and glossary-entries-rest.js, which the portal also reads for its tooltips. Edit the entries there, then run `npm run glossary:update` in source/cli. -->',
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
    if (e.token) extra.push(`Machine token: ${e.token}.`);
    if (e.not) extra.push(`Not called: ${e.not}.`);
    if (e.see) extra.push(`More: [${pageTitle(e.see)}](${e.see}).`);
    if (extra.length > 0) out.push('', extra.join(' '));
  }
  return out.join('\n') + '\n';
}
