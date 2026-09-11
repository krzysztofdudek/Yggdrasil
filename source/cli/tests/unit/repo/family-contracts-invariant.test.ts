// =============================================================================
// GUARD 4 — the family-contracts register must not drift from the code.
//
// The bug class: `docs/family-contracts.md` is the ONE place that says which
// machine documents this family exchanges, what each one's schema id is, who
// writes it and who reads it. A register nobody checks is a register that is
// wrong — a new `*_JSON_SCHEMA` constant lands in `src/formatters/` and the page
// never hears about it, or a document is retired from the code and its row sits
// on the page forever. Either way a consumer in another repository reads the
// page, believes it, and breaks against a shape that is no longer there.
//
// INVARIANT (both directions — this is what makes the page law rather than
// commentary; a one-way assertion lets a ghost row live indefinitely):
//   (→) Every `*_JSON_SCHEMA` constant declared in `source/cli/src/formatters/`
//       appears on the page as a WHOLE word.
//   (←) Every `yg-<name>/<n>`-shaped id on the page is either one of those
//       constants OR is on the explicit whitelist below — documents produced
//       somewhere other than `src/formatters/`, each named with its producer.
//
// It also pins the page's SHAPE, because the two halves above are only as good
// as the table they read: exactly one six-column table, no empty cell, no
// duplicate schema id, and every "described where" cell pointing at a docs page
// that actually exists. And it pins the page's WIRING: a doc page absent from
// the `doc-page` node's `mapping:` is a `type-strict-orphan` under this repo's
// own strict enforcement, and a page absent from the VitePress sidebar is a page
// nobody can navigate to.
//
// Constants are extracted by READING the formatter files as text and matching a
// regex — deliberately NOT by importing the modules. An import only ever sees
// what something re-exports; a constant declared and used locally would be
// invisible to it, and that is exactly the constant most likely to be forgotten
// on the page.
//
// Scenario 9 is the self-test: the checking logic lives in a pure function that
// is fed a synthetic broken page built in memory, and must name the missing id.
// Without it this file passes just as happily when it has stopped checking
// anything at all.
//
// Hermetic & fast: reads repo files via fs, paths derived from import.meta.url
// (repo-check runs it from another directory). Spawns nothing. No network, no
// clock, no randomness.
//
// This is a UNIT test, not an e2e one, because it must read `src/**` — which the
// `e2e-public-surface` rule forbids an e2e test from doing.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tests/unit/repo → repo root is five levels up: repo/unit/tests/cli/source.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');

const FORMATTERS_DIR = path.join(REPO_ROOT, 'source', 'cli', 'src', 'formatters');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const PAGE_REL = 'docs/family-contracts.md';
const PAGE_PATH = path.join(REPO_ROOT, PAGE_REL);
const SIDEBAR_PATH = path.join(REPO_ROOT, 'docs', '.vitepress', 'config.ts');
const DOC_NODE_PATH = path.join(REPO_ROOT, '.yggdrasil', 'model', 'docs', 'guides', 'yg-node.yaml');

/**
 * The lower bound on how many schema constants `src/formatters/` declares. It is
 * NOT a count of today's constants (that would have to be edited on every
 * addition) — it is the tripwire for a regex that has stopped matching. A regex
 * silently returning the empty set makes every containment assertion below pass
 * vacuously, which is the quietest way this guard could fail.
 */
const MIN_CONSTANTS = 10;

/**
 * Schema ids that are legitimately on the page but are NOT `*_JSON_SCHEMA`
 * constants under `src/formatters/`. Every entry names who produces it, because
 * an unexplained whitelist entry is how a ghost row gets laundered into a
 * legitimate one.
 *
 * Only `yg-<name>/<n>`-shaped ids need to be here: the extraction below matches
 * that shape alone, so `grain-advice/1`, `grain-proposal/1`, `grain-export/1`,
 * `horde-law/1`, `horde-retro/1`, `horde-plan/1`, `horde-drill-case/1` and the
 * schema-less `yg-events` line never reach it. Half (b) of this guard — the seam
 * test in Grain, the only CI with all three checkouts — is what holds those to
 * the page.
 */
const NON_FORMATTER_IDS: ReadonlyArray<{ id: string; producer: string }> = [
  // The package mechanism's three documents live in src/io/, not src/formatters/:
  // two are written by a human author outside this repo, one is a lock yg writes.
  { id: 'yg-marketplace/1', producer: 'a marketplace author (read by `yg pack`, `yg marketplace check`)' },
  { id: 'yg-package/1', producer: 'a package author (read by `yg pack`, `yg marketplace check`)' },
  { id: 'yg-packages/1', producer: 'Yggdrasil `yg pack` — the installed-package lock' },
];

// ---------------------------------------------------------------------------
// Pure functions. Everything the assertions below rely on is here, taking
// strings and returning values, so scenario 9 can run them on literals.
// ---------------------------------------------------------------------------

/** Every `export const <NAME>_JSON_SCHEMA = '<id>'` id in one formatter file's text. */
export function extractSchemaConstants(source: string): string[] {
  const re = /export const \w+_JSON_SCHEMA = '([^']+)'/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  return out;
}

/** Escape a string for literal use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Whole-word containment. `yg-node/1` must NOT be satisfied by `yg-node/12` (a
 * later version number) nor by a longer id that happens to end with it, so the
 * match is bounded on both sides: nothing word-ish, `/` or `-` before it, and no
 * digit after it.
 */
export function pageMentions(page: string, id: string): boolean {
  return new RegExp(`(?<![\\w/-])${escapeRe(id)}(?!\\d)`).test(page);
}

/**
 * THE checking function scenario 9 proves can go red: the ids that should be on
 * the page and are not, in the order they were given.
 */
export function missingFromPage(page: string, ids: readonly string[]): string[] {
  return ids.filter((id) => !pageMentions(page, id));
}

/** Every `yg-<name>/<n>`-shaped id mentioned anywhere on the page, deduplicated. */
export function idsOnPage(page: string): string[] {
  return [...new Set(page.match(/yg-[a-z-]+\/\d+/g) ?? [])];
}

interface TableRow {
  /** 1-based line number in the page, for failure messages. */
  line: number;
  cells: string[];
}

interface ParsedTable {
  headerLine: number;
  header: string[];
  rows: TableRow[];
}

/**
 * Parse every GitHub-flavoured markdown table on the page. A table is a header
 * row immediately followed by a separator row (`| --- | --- |`), then data rows
 * until the first line that is not a table row.
 *
 * This is the function the Grain seam test carries a SECOND, INDEPENDENT COPY
 * of. The duplication is deliberate: the seam job cannot import this repo's
 * code, and ten lines of regex copied once is cheaper than a shared package
 * three repositories would then have to version together.
 */
export function parseTables(page: string): ParsedTable[] {
  const lines = page.split(/\r?\n/);
  const cellsOf = (line: string): string[] | null => {
    const t = line.trim();
    if (!t.startsWith('|') || !t.endsWith('|') || t.length < 2) return null;
    return t.slice(1, -1).split('|').map((c) => c.trim());
  };
  const isSeparator = (cells: string[] | null): boolean =>
    cells !== null && cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));

  const tables: ParsedTable[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = cellsOf(lines[i]);
    if (header === null || isSeparator(header)) continue;
    if (!isSeparator(cellsOf(lines[i + 1] ?? ''))) continue;
    const rows: TableRow[] = [];
    let j = i + 2;
    for (; j < lines.length; j++) {
      const cells = cellsOf(lines[j]);
      if (cells === null) break;
      rows.push({ line: j + 1, cells });
    }
    tables.push({ headerLine: i + 1, header, rows });
    i = j - 1;
  }
  return tables;
}

/** Strip markdown emphasis/code fencing around a cell's text. */
function bare(cell: string): string {
  return cell.replace(/`/g, '').trim();
}

/**
 * The schema id a row declares, or null when the row deliberately declares none
 * (`.family-candidates.json` carries no `schema` field and versions itself by
 * `v`). A row with no id is legal; a row with an EMPTY cell is not, and scenario
 * 5 catches that separately.
 */
export function rowSchemaId(cell: string): string | null {
  const m = bare(cell).match(/^([a-z][a-z0-9-]*\/\d+)\b/);
  return m ? m[1] : null;
}

/**
 * Every markdown link target in a cell, anchor stripped, expressed as a
 * REPO-relative path. VitePress resolves an absolute link (`/packages`) against
 * the docs root, not the repo root, so both it and a relative one
 * (`./packages.md`) land on `docs/<page>.md`.
 */
export function docTargetsIn(cell: string): string[] {
  const out: string[] = [];
  const re = /\[[^\]]*\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cell)) !== null) {
    const raw = m[1].split('#')[0].trim();
    if (raw === '' || /^[a-z]+:/i.test(raw) || raw.startsWith('//')) continue;
    const rel = raw.replace(/^\.\//, '').replace(/^\//, '');
    out.push(`docs/${rel.endsWith('.md') ? rel : `${rel}.md`}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The repository's real state, read once.
// ---------------------------------------------------------------------------

const formatterFiles = readdirSync(FORMATTERS_DIR)
  .filter((f) => f.endsWith('.ts'))
  .sort();

/** id → the formatter file it is declared in, for failure messages. */
const CONSTANTS = new Map<string, string>();
for (const file of formatterFiles) {
  const text = readFileSync(path.join(FORMATTERS_DIR, file), 'utf-8');
  for (const id of extractSchemaConstants(text)) CONSTANTS.set(id, `src/formatters/${file}`);
}

const PAGE = existsSync(PAGE_PATH) ? readFileSync(PAGE_PATH, 'utf-8') : '';

describe('GUARD 4 — docs/family-contracts.md and the code agree', () => {
  it('the page exists', () => {
    expect(existsSync(PAGE_PATH), `${PAGE_REL} is missing — the family register has no home`).toBe(true);
  });

  // 1 — the constant set itself.
  it('collects the schema constants by reading src/formatters/ as text', () => {
    expect(
      formatterFiles.length,
      `no .ts files under ${FORMATTERS_DIR} — the directory moved and this guard is reading nothing`,
    ).toBeGreaterThan(0);
    expect(
      CONSTANTS.size,
      `found ${CONSTANTS.size} *_JSON_SCHEMA constants under src/formatters/, expected at least ${MIN_CONSTANTS}. ` +
        'Either documents were removed, or the extraction regex has stopped matching and every assertion ' +
        'below is now passing vacuously.',
    ).toBeGreaterThanOrEqual(MIN_CONSTANTS);
  });

  // 2 — code → page.
  it('lists every schema constant on the page, as a whole word', () => {
    const ids = [...CONSTANTS.keys()].sort();
    const missing = missingFromPage(PAGE, ids);
    expect(
      missing,
      `these schema ids are declared in the code but absent from ${PAGE_REL}: ` +
        missing.map((id) => `${id} (${CONSTANTS.get(id)})`).join(', ') +
        `. Add a row for each — document, schema id, producer, consumers, since, described where.`,
    ).toEqual([]);
  });

  // 3 — page → code.
  it('has no ghost id on the page', () => {
    const whitelisted = new Set(NON_FORMATTER_IDS.map((e) => e.id));
    const ghosts = idsOnPage(PAGE).filter((id) => !CONSTANTS.has(id) && !whitelisted.has(id));
    expect(
      ghosts,
      `${PAGE_REL} names ${ghosts.join(', ')}, which no *_JSON_SCHEMA constant under src/formatters/ declares. ` +
        'Either the document was retired (drop the row — the page must not outlive the code) or it is produced ' +
        'outside this repository, in which case add it to NON_FORMATTER_IDS in this test with its producer.',
    ).toEqual([]);
  });

  // 4 — the table's shape.
  it('carries exactly one table, with the six agreed columns', () => {
    const tables = parseTables(PAGE);
    expect(
      tables.length,
      `expected exactly one table on ${PAGE_REL}, found ${tables.length}. The register is one table; a second ` +
        'one makes it ambiguous which rows the guard reads.',
    ).toBe(1);
    const [table] = tables;
    expect(
      table.header.length,
      `the header on line ${table.headerLine} has ${table.header.length} columns: ${table.header.join(' | ')}. ` +
        'The register has six: document, schema id, producer, consumers, since, described where.',
    ).toBe(6);
    expect(table.rows.length, 'the register has no rows').toBeGreaterThan(0);
  });

  // 5 — every cell answered.
  it('answers all six cells on every row', () => {
    const [table] = parseTables(PAGE);
    const bad = table.rows.filter((r) => r.cells.length !== 6 || r.cells.some((c) => c.trim() === ''));
    expect(
      bad,
      'these rows leave a cell empty or do not have six cells: ' +
        bad.map((r) => `line ${r.line}: ${r.cells.join(' | ')}`).join(' ;; ') +
        '. Every column is an answer somebody needs; "no external consumer" is an answer, blank is not.',
    ).toEqual([]);
  });

  // 6 — one row per document.
  it('declares no schema id twice', () => {
    const [table] = parseTables(PAGE);
    const seen = new Map<string, number>();
    const dupes: string[] = [];
    for (const row of table.rows) {
      const id = rowSchemaId(row.cells[1] ?? '');
      if (id === null) continue;
      const first = seen.get(id);
      if (first !== undefined) dupes.push(`${id} (lines ${first} and ${row.line})`);
      else seen.set(id, row.line);
    }
    expect(dupes, `duplicate schema ids on ${PAGE_REL}: ${dupes.join(', ')}`).toEqual([]);
  });

  // 7 — "described where" goes somewhere real.
  it('points every "described where" cell at a docs page that exists', () => {
    const [table] = parseTables(PAGE);
    const broken: string[] = [];
    for (const row of table.rows) {
      const cell = row.cells[5] ?? '';
      const targets = docTargetsIn(cell);
      if (targets.length === 0) {
        broken.push(`line ${row.line}: "${cell}" carries no link to a docs page`);
        continue;
      }
      for (const t of targets) {
        if (!existsSync(path.join(REPO_ROOT, t))) {
          broken.push(`line ${row.line}: "${cell}" points at ${t}, which does not exist`);
        }
      }
    }
    expect(
      broken,
      'the register points somewhere that is not there: ' +
        broken.join(' ;; ') +
        `. (Pages live under ${path.relative(REPO_ROOT, DOCS_DIR)}/; the rail docs-internal-links checks prose ` +
        'links, and this is the same check for a table cell that may carry only a page name.)',
    ).toEqual([]);
  });

  // 8 — the page is wired in.
  it('is mapped by the doc-page node and listed in the VitePress sidebar', () => {
    const nodeYaml = readFileSync(DOC_NODE_PATH, 'utf-8');
    expect(
      nodeYaml.includes(PAGE_REL),
      `${PAGE_REL} is not in the mapping: of ${path.relative(REPO_ROOT, DOC_NODE_PATH)}. The doc-page type is ` +
        'enforce: strict, so an unmapped page is a type-strict-orphan and yg check goes red.',
    ).toBe(true);
    const sidebar = readFileSync(SIDEBAR_PATH, 'utf-8');
    expect(
      sidebar.includes('/family-contracts'),
      `/family-contracts is not in the sidebar of ${path.relative(REPO_ROOT, SIDEBAR_PATH)} — the page builds ` +
        'but nobody can reach it.',
    ).toBe(true);
  });

  // 9 — the guard's own self-test.
  describe('the checker can go red (self-test on literals, not on the repo)', () => {
    const SYNTHETIC = [
      '# Family contracts',
      '',
      '| Document | Schema id | Producer | Consumers | Since | Described where |',
      '| --- | --- | --- | --- | --- | --- |',
      '| Run report | `yg-check/1` | Yggdrasil | Horde | 6.0.0 | [CLI Reference](/cli-reference) |',
      '| Component | `yg-node/1` | Yggdrasil | Horde | 6.0.0 | [CLI Reference](/cli-reference) |',
      '',
    ].join('\n');

    it('names the id a page has left out', () => {
      const missing = missingFromPage(SYNTHETIC, ['yg-check/1', 'yg-node/1', 'yg-context/1']);
      expect(missing).toEqual(['yg-context/1']);
    });

    it('does not let a longer version number stand in for a shorter one', () => {
      expect(pageMentions('| x | `yg-node/12` | y |', 'yg-node/1')).toBe(false);
      expect(pageMentions('| x | `yg-node/1` | y |', 'yg-node/1')).toBe(true);
    });

    it('finds a ghost id a page invented', () => {
      const page = `${SYNTHETIC}| Ghost | \`yg-ghost/1\` | ? | ? | ? | ? |\n`;
      const known = new Set(['yg-check/1', 'yg-node/1']);
      expect(idsOnPage(page).filter((id) => !known.has(id))).toEqual(['yg-ghost/1']);
    });

    it('reads a six-column table off a literal, and rejects a five-column one', () => {
      const [ok] = parseTables(SYNTHETIC);
      expect(ok.header).toEqual(['Document', 'Schema id', 'Producer', 'Consumers', 'Since', 'Described where']);
      expect(ok.rows).toHaveLength(2);
      expect(rowSchemaId(ok.rows[0].cells[1])).toBe('yg-check/1');
      expect(docTargetsIn(ok.rows[0].cells[5])).toEqual(['docs/cli-reference.md']);

      const fiveCol = ['| A | B | C | D | E |', '| --- | --- | --- | --- | --- |', '| 1 | 2 | 3 | 4 | 5 |'].join('\n');
      expect(parseTables(fiveCol)[0].header).toHaveLength(5);
    });

    it('sees an empty cell in a literal row', () => {
      const holed = SYNTHETIC.replace('| Yggdrasil | Horde | 6.0.0 |', '|  | Horde | 6.0.0 |');
      const [table] = parseTables(holed);
      expect(table.rows.some((r) => r.cells.some((c) => c.trim() === ''))).toBe(true);
    });

    it('extracts a constant from formatter source text without importing it', () => {
      const src = "const x = 1;\nexport const FAKE_JSON_SCHEMA = 'yg-fake/3';\n";
      expect(extractSchemaConstants(src)).toEqual(['yg-fake/3']);
      expect(extractSchemaConstants('export const NOT_A_SCHEMA = 1;')).toEqual([]);
    });
  });
});
