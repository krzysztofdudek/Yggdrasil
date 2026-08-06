// =============================================================================
// PER-UNIT COMPANION FILES — fail-closed E2E (plan §11.2 cli-llm-companion-failclosed).
//
// Real spawned binary + in-process Ollama-protocol mock reviewer (runAsync, never
// spawnSync while the mock serves). Every assembly failure of a companion aspect is
// INFRA-FAIL: NOTHING is written for that pair, the reviewer is never billed for it,
// `yg check` stays red (exit 1), and a what/why/next message is printed. OTHER pairs
// still fill on the same run.
//
// CRITICAL: the broken-companion variant aspects are NOT pre-baked in the fixture —
// an aspect with a validation error (companion.mjs without content.md, or with
// check.mjs) would make `yg check` fail by mere existence in aspects/, breaking the
// SHARED fixture. So each test COPIES the fixture, then WRITES the broken aspect dir
// + attaches it (mutating the copy), exactly like cli-scope-llm.test.ts. Cleaned up
// via rmSync in finally.
//
// Covered (cases 12–19 + additions):
//   12 hook THROWS → infra-fail (pair unverified, exit 1, nothing written, OTHER
//      pairs still fill, a what/why/next printed)
//   13 companion path MISSING → infra-fail
//   14 companion path OUTSIDE allowed-reads (uses relation removed) → infra-fail; the
//      NEXT names the OWNING node (relation source) + the target owner, and NOT the
//      scenario .md subject as the relation site (negative assertion)
//   14b companion path under coverage.excluded, relation STILL declared → infra-fail;
//      the message says excluded, never sends the adopter to declare a relation
//   15 bad RETURN SHAPE (not array of {path}) → infra-fail
//   16 companion.mjs IMPORT/SYNTAX error → infra-fail
//   17 companion.mjs WITHOUT content.md → validator error aspect-companion-without-content
//   18 companion.mjs WITH check.mjs → validator error aspect-companion-with-check
//   19 RECOVERY: after fixing the cause, the next --approve fills the pair (exit 0)
//   +  yg-suppress: a file-level yg-suppress(<aspect-id>) in the SUBJECT .md waives a
//      refusal (mock satisfied:false → suppress → approved/exit 0); a control suppress
//      naming a DIFFERENT aspect-id leaves it refused; a marker in the COMPANION (spec)
//      file is NOT honored (companion is read-only — only <source-files> markers count)
//   +  ad-hoc `yg aspect-test --aspect <companion-llm> --files <scenario.md>` (no --node)
//      rejects with the "LLM requires graph context" message (no crash)
//
// HERMETIC: fresh mkdtemp copy of the fixture per test, mutated in place, rmSync'd in
// finally. No fixed ports, no clock/random assertions.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync, type ChatRequest } from './support/mock-reviewer.js';
import { readLock as readTriadLock } from './support/read-lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-companion');
const distExists = existsSync(BIN_PATH);

const cfgPath = (d: string) => path.join(d, '.yggdrasil', 'yg-config.yaml');
const nodeYaml = (d: string, n: string) => path.join(d, '.yggdrasil', 'model', ...n.split('/'), 'yg-node.yaml');
const aspectDir = (d: string, a: string) => path.join(d, '.yggdrasil', 'aspects', a);
// The verdict lock is a three-file triad under .yggdrasil/. The LLM aspects under
// test here record their verdicts in yg-lock.nondeterministic.json; readTriadLock
// merges the triad into the unified { version, verdicts, nodes } shape this test
// inspects.
const readLock = (d: string): Record<string, unknown> =>
  readTriadLock(path.join(d, '.yggdrasil')) as unknown as Record<string, unknown>;
const scenarioMd = (d: string, name: string) => path.join(d, 'references', 'e2e-test-scenarios', name);
const specTs = (d: string, name: string) => path.join(d, 'apps', 'e2e', 'tests', name);

const SCENARIOS = ['checkout', 'login', 'search'] as const;
const UNIT = (name: string) => `file:references/e2e-test-scenarios/${name}.md`;

function run(args: string[], cwd: string): { all: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  return { all: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}
function pointReviewer(dir: string, endpoint: string): void {
  const p = cfgPath(dir);
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${endpoint}"`), 'utf-8');
}
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-companion-fc-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}
/** Swap the scenarios node's single attached aspect to a variant. */
function useAspect(dir: string, aspectId: string): void {
  const p = nodeYaml(dir, 'scenarios');
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/- scenario-matches-test\b/, `- ${aspectId}`), 'utf-8');
}
/**
 * Write a brand-new companion-bearing LLM aspect dir into the COPY and attach it
 * to the scenarios node (replacing the baked-in attach). content.md + a per:file
 * scope mirror the fixture's scenario-matches-test so the only variable under
 * test is the companion.mjs body (and, for the validator cases, which rule
 * sources are present).
 */
function writeAspect(
  dir: string,
  id: string,
  opts: { companionMjs?: string; contentMd?: string | null; checkMjs?: string },
): void {
  const adir = aspectDir(dir, id);
  mkdirSync(adir, { recursive: true });
  writeFileSync(
    path.join(adir, 'yg-aspect.yaml'),
    [`name: ${id}`, `description: Variant companion aspect under fail-closed test.`, 'reviewer:', '  type: llm', 'status: enforced', 'scope:', '  per: file', ''].join('\n'),
    'utf-8',
  );
  if (opts.contentMd !== null) {
    writeFileSync(path.join(adir, 'content.md'), opts.contentMd ?? '# Variant rule\n\nVerify the scenario has at least one step.\n', 'utf-8');
  }
  if (opts.companionMjs !== undefined) writeFileSync(path.join(adir, 'companion.mjs'), opts.companionMjs, 'utf-8');
  if (opts.checkMjs !== undefined) writeFileSync(path.join(adir, 'check.mjs'), opts.checkMjs, 'utf-8');
  useAspect(dir, id);
}

type Verdicts = Record<string, Record<string, { hash: string; touched?: Array<[string, string]>; verdict: string; reason?: string }>>;
const verdicts = (d: string, aspectId: string): Verdicts[string] => (readLock(d).verdicts as Verdicts)[aspectId] ?? {};

/**
 * Extract the <source-files>…</source-files> DATA region of a captured prompt
 * (the subject region). NOTE: the literal token "<source-files>" also appears in
 * the task instructions near the top of the prompt (the suppress instruction
 * mentions "spans into the files in <source-files>"), so we key off lastIndexOf
 * for the OPENING tag — the data block is the last <source-files> in the prompt —
 * and the (unique) closing tag.
 */
function sourceFilesRegion(prompt: string): string {
  const start = prompt.lastIndexOf('<source-files>');
  const end = prompt.indexOf('</source-files>');
  return start >= 0 && end >= 0 ? prompt.slice(start, end) : '';
}

describe.skipIf(!distExists)('CLI E2E — per-unit companion files (fail-closed)', () => {
  // ===========================================================================
  // (12) HOOK THROWS → infra-fail for the checkout pair only. The other two pairs
  //   (login, search) still fill on the same run. The lock gains NO entry for the
  //   thrown pair; `yg check` stays red; a what/why/next is printed.
  // ===========================================================================
  it('(12) a throwing companion hook is infra-fail: pair unverified, others still fill, message printed', async () => {
    const dir = copyFixture('throw');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      // Hook throws ONLY for the checkout scenario; resolves the paired spec otherwise.
      writeAspect(dir, 'throwing-companion', {
        companionMjs: [
          'export function companion(ctx) {',
          '  const s = ctx.subject[0];',
          "  if (s.path.endsWith('checkout.md')) throw new Error('boom: deliberate hook failure');",
          '  const m = /^---\\r?\\n([\\s\\S]*?)\\r?\\n---/.exec(s.content);',
          "  const test = /test:\\s*(.*)/.exec(m[1])[1].trim();",
          '  const p = `apps/e2e/tests/${test}`;',
          '  void ctx.fs.read(p);',
          '  return [{ path: p }];',
          '}',
          '',
        ].join('\n'),
      });

      const fill = await runAsync(['check', '--approve'], dir);
      // Infra-fail on the checkout pair → exit 1.
      expect(fill.status).toBe(1);
      // The §4 gate now resolves the companion LIVE during the --approve run's final
      // report, so the throwing-hook failure surfaces as a blocking grouped
      // aspect-companion-runtime-error whose shared why carries the hook's OWN error
      // (the old generic "companion hook threw" what line is no longer rendered).
      expect(fill.all).toContain('aspect-companion-runtime-error');
      expect(fill.all).toContain('boom: deliberate hook failure');
      expect(fill.all).toContain('- scenarios');

      // The OTHER two pairs filled (reviewer billed for them, not the thrown one).
      const v = verdicts(dir, 'throwing-companion');
      expect(v[UNIT('login')]?.verdict).toBe('approved');
      expect(v[UNIT('search')]?.verdict).toBe('approved');
      // Nothing written for the thrown pair.
      expect(v[UNIT('checkout')]).toBeUndefined();
      // Reviewer was called for exactly the two resolvable pairs — the thrown one
      // never reached the reviewer (resolution precedes consensus).
      expect(mock.chatCount()).toBe(2);

      // `yg check` stays red. Since v5.2.0 the §4 prompt-size gate is unconditional
      // (an omitted max_prompt_chars defaults to 50000), so plain `yg check` resolves
      // the companion LIVE to size the gate — and a throwing hook surfaces directly as
      // a blocking aspect-companion-runtime-error carrying the hook's OWN message,
      // rather than the generic per-unit "No valid verdict" (unverified) rendering.
      const after = run(['check'], dir);
      expect(after.status).toBe(1);
      // Grouped view: the blocking runtime-error group fires for this aspect, its
      // shared why carries the hook's OWN thrown error, and exactly ONE pair (the
      // checkout unit) is a member — the resolvable login/search pairs resolve fine
      // and never enter the group. The per-unit `what` is no longer rendered.
      expect(after.all).toContain('aspect-companion-runtime-error');
      expect(after.all).toContain("aspect 'throwing-companion'");
      expect(after.all).toContain('boom: deliberate hook failure');
      expect(after.all).toContain('1 pairs');
      expect(after.all).toContain('- scenarios');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  // ===========================================================================
  // (13) COMPANION PATH MISSING → infra-fail. The hook returns a relation-reachable
  //   path under the spec node's directory, but the file does not exist on disk.
  // ===========================================================================
  it('(13) a companion path that does not exist is infra-fail (pair unverified)', async () => {
    const dir = copyFixture('missing');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      // Returns a path inside the spec node's mapping that has no file on disk.
      writeAspect(dir, 'missing-companion', {
        companionMjs: [
          'export function companion(ctx) {',
          '  void ctx;',
          "  return [{ path: 'apps/e2e/tests/does-not-exist.spec.ts' }];",
          '}',
          '',
        ].join('\n'),
      });

      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      // The companion read fails closed; message names the missing path.
      expect(fill.all).toContain('does-not-exist.spec.ts');
      // Nothing written for any pair (every unit returns the same missing path).
      const v = verdicts(dir, 'missing-companion');
      for (const s of SCENARIOS) expect(v[UNIT(s)]).toBeUndefined();
      // The reviewer was never billed — resolution failed before consensus.
      expect(mock.chatCount()).toBe(0);

      // Since v5.2.0 the §4 gate is unconditional (omitted max_prompt_chars → 50000),
      // so plain `yg check` resolves the companion LIVE to size the gate. A companion
      // path that cannot be read surfaces as a blocking aspect-companion-runtime-error
      // per unit (naming the missing path + the unit), not the generic per-unit
      // "No valid verdict" unverified rendering.
      const after = run(['check'], dir);
      expect(after.status).toBe(1);
      // Grouped view: every unit returns the same missing path → all three pairs
      // are members of the runtime-error group (3 pairs). The per-unit `what`
      // ("...could not be read.") is no longer rendered; the missing path survives
      // in the shared Fix text, and the 3-pair count proves every unit is blocked.
      expect(after.all).toContain('aspect-companion-runtime-error');
      expect(after.all).toContain('3 pairs');
      expect(after.all).toContain('does-not-exist.spec.ts');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  // ===========================================================================
  // (14) COMPANION OUTSIDE ALLOWED-READS → infra-fail. With the `uses` relation
  //   removed, the spec file is no longer relation-reachable. The NEXT message must
  //   name the OWNING node (scenarios — the relation SOURCE) + the target owner
  //   (specs), and must NOT name the per:file .md subject as the relation site (a
  //   .md subject cannot hold a relation).
  // ===========================================================================
  it('(14) an out-of-reach companion is infra-fail; message names the owning node, NOT the .md subject', async () => {
    const dir = copyFixture('outside');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      // A hook that RETURNS the spec path WITHOUT reading it via ctx.fs — so the
      // out-of-reach disposition is decided by resolveCompanionDescriptors's
      // allowed-reads guard (companionOutsideAllowedReads), which frames the
      // relation source/target. (Had the hook called ctx.fs.read itself, the
      // undeclared-read would fire inside the hook with a different, generic
      // message — see the docstring on companionOutsideAllowedReads.) Then remove
      // the `uses` relation so the spec node is no longer reachable.
      writeAspect(dir, 'outside-companion', {
        companionMjs: ['export function companion(ctx) {', '  void ctx;', "  return [{ path: 'apps/e2e/tests/checkout.spec.ts' }];", '}', ''].join('\n'),
      });
      const np = nodeYaml(dir, 'scenarios');
      writeFileSync(np, readFileSync(np, 'utf-8').replace(/relations:\n {2}- target: specs\n {4}type: uses\n/, ''), 'utf-8');

      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      // Grouped view: the out-of-reach companion surfaces as the blocking
      // runtime-error group. The per-unit `what` ("is outside the node's
      // allowed-reads") is no longer rendered; the framing survives in the shared
      // Fix, which names the relation SOURCE (scenarios) and TARGET owner (specs).
      expect(fill.all).toContain('aspect-companion-runtime-error');
      expect(fill.all).toContain('declare a relation from scenarios to specs');
      expect(fill.all).toContain('.yggdrasil/model/scenarios/yg-node.yaml');

      // NEGATIVE: the .md subject is never named as the relation SITE. The unit
      // key (file:references/...) appears in the `what` line as the subject of
      // review, but it is never framed as where a relation must be declared.
      expect(fill.all).not.toContain('declare a relation from references/e2e-test-scenarios');
      expect(fill.all).not.toContain('declare a relation from file:references');
      expect(fill.all).not.toContain('model/references/e2e-test-scenarios');

      // Nothing written; reviewer never billed (resolution precedes consensus).
      const v = verdicts(dir, 'outside-companion');
      for (const s of SCENARIOS) expect(v[UNIT(s)]).toBeUndefined();
      expect(mock.chatCount()).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  // ===========================================================================
  // (14b) a companion path under coverage.excluded is infra-fail EVEN THOUGH the
  // relation to its owner is still declared — the opposite shape from (14): there
  // the fix is to declare the relation, here no relation can ever fix it, so the
  // message must say excluded, not send the adopter to declare a relation that
  // already exists.
  // ===========================================================================
  it('(14b) a companion path under coverage.excluded is infra-fail with the relation still declared; the message says excluded, never declare-a-relation', async () => {
    const dir = copyFixture('companion-excluded');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      // Same frontmatter-driven pairing as the fixture's baked-in scenario-matches-test
      // (each scenario resolves its OWN paired spec), but never calls ctx.fs.read itself —
      // so the disposition is decided by resolveCompanionDescriptors's allowed-reads guard,
      // exactly like (14) above.
      writeAspect(dir, 'excluded-companion', {
        companionMjs: [
          "const SPEC_DIR = 'apps/e2e/tests';",
          'export function companion(ctx) {',
          '  const scenario = ctx.subject[0];',
          '  const match = /^---\\r?\\n([\\s\\S]*?)\\r?\\n---/.exec(scenario.content);',
          '  const meta = {};',
          '  for (const line of match[1].split(/\\r?\\n/)) {',
          '    const kv = /^([A-Za-z0-9_-]+):\\s*(.*)$/.exec(line);',
          '    if (kv) meta[kv[1]] = kv[2].trim();',
          '  }',
          '  return [{ path: `${SPEC_DIR}/${meta.test}` }];',
          '}',
          '',
        ].join('\n'),
      });
      // The scenarios -> specs relation is left declared (untouched) — only
      // checkout's paired spec is placed under coverage.excluded.
      const cp = cfgPath(dir);
      writeFileSync(cp, `${readFileSync(cp, 'utf-8')}coverage:\n  excluded:\n    - apps/e2e/tests/checkout.spec.ts\n`, 'utf-8');

      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      expect(fill.all).toContain('aspect-companion-runtime-error');
      expect(fill.all).toContain('excluded from graph coverage by design');
      expect(fill.all).not.toContain('declare a relation from scenarios to specs');

      // Nothing written for the excluded pair; the reviewer never sees it.
      const v = verdicts(dir, 'excluded-companion');
      expect(v[UNIT('checkout')]).toBeUndefined();

      // Control: login and search pair their OWN, non-excluded specs and still
      // fill normally in the SAME run — the exclusion never silences generally.
      expect(v[UNIT('login')]?.verdict).toBe('approved');
      expect(v[UNIT('search')]?.verdict).toBe('approved');
      expect(mock.chatCount()).toBe(2);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  // ===========================================================================
  // (15) BAD RETURN SHAPE (not an array of { path }) → infra-fail.
  // ===========================================================================
  it('(15) a bad companion return shape is infra-fail (pair unverified)', async () => {
    const dir = copyFixture('badshape');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      // Returns a non-array (an object) — the runner cannot interpret it.
      writeAspect(dir, 'badshape-companion', {
        companionMjs: ['export function companion(ctx) {', '  void ctx;', "  return { path: 'apps/e2e/tests/checkout.spec.ts' };", '}', ''].join('\n'),
      });

      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      // Grouped view: the bad return shape surfaces as the blocking runtime-error
      // group. The per-unit `what` ("expected an array of …") is no longer rendered;
      // the shape requirement survives in the shared why + Fix.
      expect(fill.all).toContain('aspect-companion-runtime-error');
      expect(fill.all).toContain('a non-array return cannot be interpreted');
      expect(fill.all).toContain('Return [] or { path, label? }[] from companion.');
      const v = verdicts(dir, 'badshape-companion');
      for (const s of SCENARIOS) expect(v[UNIT(s)]).toBeUndefined();
      expect(mock.chatCount()).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  // ===========================================================================
  // (15b) BAD ENTRY SHAPE (array of non-{path}) → infra-fail. Distinct from (15):
  //   the return IS an array, but an element lacks a string `path`.
  // ===========================================================================
  it('(15b) an array element without a string path is infra-fail', async () => {
    const dir = copyFixture('badentry');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      writeAspect(dir, 'badentry-companion', {
        companionMjs: ['export function companion(ctx) {', '  void ctx;', "  return [{ notPath: 'x' }];", '}', ''].join('\n'),
      });
      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      // Grouped view: an array element without a string path surfaces as the
      // blocking runtime-error group. The per-unit `what` ("not { path: string,
      // label?: string }") is no longer rendered; the descriptor requirement
      // survives in the shared why + Fix.
      expect(fill.all).toContain('aspect-companion-runtime-error');
      expect(fill.all).toContain("Each companion descriptor must carry a string 'path'");
      expect(fill.all).toContain('Return objects shaped { path: string, label?: string } from companion.');
      const v = verdicts(dir, 'badentry-companion');
      for (const s of SCENARIOS) expect(v[UNIT(s)]).toBeUndefined();
      expect(mock.chatCount()).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  // ===========================================================================
  // (16) companion.mjs IMPORT / SYNTAX error → infra-fail (the dynamic import fails
  //   before the hook ever runs).
  // ===========================================================================
  it('(16) a companion.mjs with an import/syntax error is infra-fail', async () => {
    const dir = copyFixture('import');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      // Unresolvable import → import() rejects.
      writeAspect(dir, 'import-broken-companion', {
        companionMjs: ["import { nope } from 'this-module-does-not-exist';", 'export function companion(ctx) {', '  void ctx; void nope;', '  return [];', '}', ''].join('\n'),
      });

      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      // Loader infra message names companion.mjs.
      expect(fill.all).toContain('companion.mjs');
      const v = verdicts(dir, 'import-broken-companion');
      for (const s of SCENARIOS) expect(v[UNIT(s)]).toBeUndefined();
      expect(mock.chatCount()).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  // ===========================================================================
  // (17) companion.mjs WITHOUT content.md → validator error
  //   aspect-companion-without-content. This BLOCKS `yg check` (with or without
  //   --approve) — it is a graph-validation error, not an infra-fail. The aspect
  //   is written with companion.mjs but no content.md.
  // ===========================================================================
  it('(17) companion.mjs without content.md emits aspect-companion-without-content (blocks check)', async () => {
    const dir = copyFixture('nocontent');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      writeAspect(dir, 'no-content-companion', {
        contentMd: null, // deliberately omit content.md
        companionMjs: ['export function companion(ctx) { void ctx; return []; }', ''].join('\n'),
      });

      // Plain check blocks on the validation error (graph-level, no LLM call).
      const chk = run(['check'], dir);
      expect(chk.status).toBe(1);
      expect(chk.all).toContain('aspect-companion-without-content');
      // The per-issue `what` ("has companion.mjs but no content.md") is no longer
      // rendered in the grouped view; the same intent is in the shared why.
      expect(chk.all).toContain('companion.mjs is an add-on for LLM aspects; it requires content.md as the primary rule source.');

      // --approve still reports the validation error and stays red. (The
      // validation error is a graph-validation diagnostic, not a fill gate, so
      // --approve does proceed to fill the aspect's pairs over an empty rule body
      // — the green block here is `yg check` after, which remains FAIL because the
      // validation error persists. The contract under test is: the broken aspect
      // BLOCKS `yg check`, which it does on both plain and --approve runs.)
      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      expect(fill.all).toContain('aspect-companion-without-content');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  // ===========================================================================
  // (18) companion.mjs WITH check.mjs → validator error aspect-companion-with-check
  //   (the more-specific code; aspect-companion-without-content is suppressed).
  // ===========================================================================
  it('(18) companion.mjs with check.mjs emits aspect-companion-with-check only', async () => {
    const dir = copyFixture('withcheck');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      // An LLM aspect with content.md + companion.mjs + check.mjs. The presence of
      // check.mjs on an LLM aspect also trips other rule-source codes, but the
      // companion-specific conflict must be the companion+check one.
      writeAspect(dir, 'companion-and-check', {
        contentMd: '# Rule\n\nVerify the scenario has a step.\n',
        companionMjs: ['export function companion(ctx) { void ctx; return []; }', ''].join('\n'),
        checkMjs: ['export function check(ctx) { void ctx; return []; }', ''].join('\n'),
      });

      const chk = run(['check'], dir);
      expect(chk.status).toBe(1);
      expect(chk.all).toContain('aspect-companion-with-check');
      // The per-issue `what` ("has companion.mjs together with check.mjs") is no
      // longer rendered in the grouped view; the same intent is in the shared why.
      expect(chk.all).toContain('companion.mjs is an add-on for LLM aspects only; it is incompatible with the deterministic check.mjs runner.');
      // The more-specific code wins: the without-content code must NOT also fire
      // for this aspect (content.md IS present anyway).
      expect(chk.all).not.toContain('aspect-companion-without-content');

      expect(mock.chatCount()).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  // ===========================================================================
  // (19) RECOVERY: a throwing hook fails closed; after the cause is fixed, the next
  //   --approve fills the pair (exit 0) — proving infra-fail leaves the pair fully
  //   refillable, never a poisoned cache.
  // ===========================================================================
  it('(19) after fixing the broken hook, the next --approve fills the pair (exit 0)', async () => {
    const dir = copyFixture('recover');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      const goodHook = [
        'export function companion(ctx) {',
        '  const s = ctx.subject[0];',
        '  const m = /^---\\r?\\n([\\s\\S]*?)\\r?\\n---/.exec(s.content);',
        "  const test = /test:\\s*(.*)/.exec(m[1])[1].trim();",
        '  const p = `apps/e2e/tests/${test}`;',
        '  void ctx.fs.read(p);',
        '  return [{ path: p }];',
        '}',
        '',
      ].join('\n');
      const brokenHook = ['export function companion(ctx) { void ctx; throw new Error("temporarily broken"); }', ''].join('\n');

      writeAspect(dir, 'recoverable-companion', { companionMjs: brokenHook });

      const broken = await runAsync(['check', '--approve'], dir);
      expect(broken.status).toBe(1);
      // Nothing written.
      expect(Object.keys(verdicts(dir, 'recoverable-companion')).length).toBe(0);

      // Fix the hook in place.
      writeFileSync(path.join(aspectDir(dir, 'recoverable-companion'), 'companion.mjs'), goodHook, 'utf-8');

      const fixed = await runAsync(['check', '--approve'], dir);
      expect(fixed.status).toBe(0);
      const v = verdicts(dir, 'recoverable-companion');
      expect(Object.keys(v).sort()).toEqual(SCENARIOS.map((s) => UNIT(s)).sort());
      for (const s of SCENARIOS) expect(v[UNIT(s)].verdict).toBe('approved');
      // A clean check passes after recovery.
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  // ===========================================================================
  // (+) yg-suppress interplay (design D1: suppress is scoped to SUBJECT files).
  //   The mock simulates an LLM that honors yg-suppress: it returns satisfied only
  //   when the marker for the aspect-under-test appears inside the <source-files>
  //   (subject) region. Otherwise it refuses. Three sub-scenarios:
  //     a) a yg-suppress(scenario-matches-test) marker IN the subject .md → honored
  //        (refusal waived → approved, exit 0)
  //     b) a control marker naming a DIFFERENT aspect-id → NOT honored → refused
  //     c) a marker in the COMPANION (spec) file → it lands in <companions>, NOT
  //        <source-files>, so it is NOT honored → refused
  // ===========================================================================

  /**
   * A mock that simulates an LLM which (1) would REFUSE the checkout scenario as a
   * rule violation, but (2) honors a file-level yg-suppress(<aspectId>) marker only
   * when it appears inside the <source-files> (subject) region. Every other unit is
   * satisfied. So with no marker the checkout unit is refused; with an honored
   * subject marker the checkout unit is waived → the whole run is green.
   */
  function suppressHonoringRespond(aspectId: string) {
    return (req: ChatRequest) => {
      const subject = sourceFilesRegion(req.prompt);
      // Only the checkout unit is the candidate violation (keyed off its subject
      // frontmatter, which is unique to the checkout scenario).
      const isCheckoutUnit = subject.includes('test: checkout.spec.ts');
      if (!isCheckoutUnit) return { satisfied: true, reason: 'no violation on this unit' };
      const honored = subject.includes(`yg-suppress(${aspectId})`);
      return honored
        ? { satisfied: true, reason: 'suppressed in subject' }
        : { satisfied: false, reason: 'rule violated and no honored suppress' };
    };
  }

  it('(+suppress a) a yg-suppress in the subject .md waives the refusal (approved, exit 0)', async () => {
    const dir = copyFixture('suppress-subject');
    const mock = await startMockReviewer({ respond: suppressHonoringRespond('scenario-matches-test') });
    try {
      pointReviewer(dir, mock.endpoint);
      // Add a file-level suppress marker to the checkout SUBJECT document. The .md
      // body is rendered verbatim in <source-files>, so the marker text reaches the
      // subject region of the prompt.
      appendFileSync(scenarioMd(dir, 'checkout.md'), '\n<!-- yg-suppress(scenario-matches-test) known scenario drift, tracked separately -->\n');

      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(0); // suppress honored on checkout; others approved too.
      const v = verdicts(dir, 'scenario-matches-test');
      expect(v[UNIT('checkout')].verdict).toBe('approved');
      expect(run(['check'], dir).status).toBe(0);

      // Assert the product guarantee (D1): the prompt's INSTRUCTION TEXT scopes suppress
      // to <source-files>. The unified instruction (Task #18) points the reviewer at
      // resolved (start-line, end-line) spans "into the files in <source-files>"; this
      // pins that wording so a regression to a weaker phrasing is caught.
      const checkoutReq = mock.chatRequests.find((r) => r.prompt.includes('test: checkout.spec.ts'));
      expect(checkoutReq).toBeDefined();
      expect(checkoutReq!.prompt).toContain('spans into the files in <source-files>');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  it('(+suppress b) a control suppress naming a DIFFERENT aspect-id does not waive (refused)', async () => {
    const dir = copyFixture('suppress-control');
    const mock = await startMockReviewer({ respond: suppressHonoringRespond('scenario-matches-test') });
    try {
      pointReviewer(dir, mock.endpoint);
      // A suppress marker for a DIFFERENT aspect — must NOT waive scenario-matches-test.
      appendFileSync(scenarioMd(dir, 'checkout.md'), '\n<!-- yg-suppress(some-other-aspect) unrelated waiver -->\n');

      const fill = await runAsync(['check', '--approve'], dir);
      // The checkout pair is refused (an enforced refusal blocks → exit 1).
      expect(fill.status).toBe(1);
      const v = verdicts(dir, 'scenario-matches-test');
      expect(v[UNIT('checkout')].verdict).toBe('refused');

      const after = run(['check'], dir);
      expect(after.status).toBe(1);
      // Grouped view: an enforced refusal renders as an `enforced` group naming the
      // aspect, with the reviewer reason retained on the member node line (refusals
      // are a FULL_WHAT code, so the per-node detail survives).
      expect(after.all).toContain('enforced');
      expect(after.all).toContain("aspect 'scenario-matches-test'");
      expect(after.all).toContain('Reviewer reason: rule violated and no honored suppress');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  it('(+suppress c) a marker in the COMPANION (spec) file is NOT honored (companion is read-only)', async () => {
    const dir = copyFixture('suppress-companion');
    const mock = await startMockReviewer({ respond: suppressHonoringRespond('scenario-matches-test') });
    try {
      pointReviewer(dir, mock.endpoint);
      // Put the suppress marker in the COMPANION (paired spec) file. It is injected
      // into <companions>, never <source-files>, so the subject-scoped suppress is
      // NOT honored (design D1).
      appendFileSync(specTs(dir, 'checkout.spec.ts'), '\n// yg-suppress(scenario-matches-test) marker in companion must be ignored\n');

      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      const v = verdicts(dir, 'scenario-matches-test');
      expect(v[UNIT('checkout')].verdict).toBe('refused');

      // Sanity: the marker really did reach the prompt — but only in <companions>,
      // never in <source-files>. Find the checkout request and assert the split.
      const checkoutReq = mock.chatRequests.find((r) => r.prompt.includes('<companion path="apps/e2e/tests/checkout.spec.ts"'));
      expect(checkoutReq).toBeDefined();
      expect(checkoutReq!.prompt).toContain('yg-suppress(scenario-matches-test)');
      expect(sourceFilesRegion(checkoutReq!.prompt)).not.toContain('yg-suppress(scenario-matches-test)');

      // Assert the product wording (D1): the instruction text that makes a companion-file
      // marker ineffective is the same scoping sentence as in suppress-a. Pin it here too
      // so a wording regression is caught in both the "honored" and "not-honored" branches.
      expect(checkoutReq!.prompt).toContain('spans into the files in <source-files>');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  // ===========================================================================
  // (+) ad-hoc `yg aspect-test --aspect <companion-llm> --files <scenario.md>` (no
  //   --node) rejects with the "LLM requires graph context" message. No reviewer
  //   calls, no crash, exit ≠ 0. This needs no mock (it must reject BEFORE any
  //   reviewer dispatch) — run it synchronously.
  // ===========================================================================
  it('(+ad-hoc) aspect-test --files on a companion LLM aspect rejects (LLM requires graph context)', () => {
    const dir = copyFixture('adhoc');
    try {
      const r = run(
        ['aspect-test', '--aspect', 'scenario-matches-test', '--files', 'references/e2e-test-scenarios/checkout.md'],
        dir,
      );
      expect(r.status).not.toBe(0);
      expect(r.all).toContain("--files cannot be used with LLM aspect 'scenario-matches-test'.");
      expect(r.all).toContain('LLM reviews require graph context');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});
