// =============================================================================
// GUARD — the docs Glossary page and the portal read one glossary.
//
// The words Yggdrasil uses are defined once, in the portal's glossary module
// (templates/portal/js/glossary.js): its entries are the portal's tooltips and
// the honest-state legend's explanations. docs/glossary.md is generated from the
// same entries, so the site and the portal cannot drift. This test renders the
// page from the module and fails on any difference; `npm run glossary:update`
// (generated-files.update.ts) rewrites the page. This test only reads.
//
// Hermetic & fast: evaluates the browser module in a vm sandbox; spawns nothing.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { anchors, loadGlossary, PAGE_PATH, render, REPO_ROOT } from './glossary-page.js';

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
