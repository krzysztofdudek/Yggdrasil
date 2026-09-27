// =============================================================================
// CLI E2E — law that reaches a whole node type is admitted by the user.
//
// A rule attached to one component is the agent's own. A rule attached to a
// node type governs every file of the type, today's and every later one, so it
// stands enforced there only once its own log holds the user's ratification of
// the version that stands now. These scenarios pin that contract on a real
// project, through the public CLI only:
//
//   1. reported    → under type_law.ratification: true, an enforced rule on a
//                    type with no ratification is an error; an advisory one, a
//                    draft one and a node-only one are not; without the
//                    setting nothing is asked for
//   2. ratified    → `yg log add --aspect --ratify` records who admitted which
//                    version on which types, and the finding goes away
//   3. refusals    → no --by, no type to admit, a --ratify on another log
//   4. changed     → editing the rule voids the admission; the finding says so
//   5. hardening   → a rule admitted while advisory may be made enforced
//   6. implied     → a rule a type's rule implies reaches the type too
//   7. committed   → only the committed file turns the requirement on or off;
//                    a local overlay cannot, and a wrong type is refused
//   8. upgrade     → yg init --upgrade records the law the graph had, once,
//                    turns the requirement on, and never records it again
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, cpSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectErrorCode, expectIssue, expectNoIssue, findIssues, parseJson, type OutputDoc } from '../support/assert-output.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

/** On the fixture's `service` type: enforced script rule, enforced reviewer rule, advisory script rule. */
const ENFORCED = 'no-todo-comments';
const ENFORCED_LLM = 'has-doc-comment';
const ADVISORY = 'requires-named-export';
const DRAFT_NOWHERE = 'wip-rule';

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** A copy of the fixture; `armed` (the default) turns type-law ratification on in its committed configuration. */
function project(label: string, armed = true): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-typelaw-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  if (armed) appendFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), '\ntype_law:\n  ratification: true\n', 'utf-8');
  return dir;
}

const aspectFile = (dir: string, rule: string, file: string): string => path.join(dir, '.yggdrasil', 'aspects', rule, file);
const configFile = (dir: string): string => path.join(dir, '.yggdrasil', 'yg-config.yaml');

function check(dir: string): OutputDoc {
  return parseJson(run(['check', '--no-approve', '--json'], dir).stdout);
}

function typeLaw(doc: OutputDoc): Array<{ aspect?: string; severity?: string; what?: string; next?: unknown }> {
  return findIssues(doc, { code: 'type-law-unratified' }) as Array<{ aspect?: string; severity?: string; what?: string }>;
}

interface LogDoc {
  entries: Array<{ at: string; body: string; ratified?: { types: string[]; version: string; by: string }; status?: { from: string; to: string } }>;
}

function readLog(dir: string, rule: string): LogDoc {
  return parseJson<LogDoc>(run(['log', 'read', '--aspect', rule, '--json'], dir).stdout);
}

function ratify(dir: string, rule: string, by = 'Jane Doe'): ReturnType<typeof run> {
  return run(['log', 'add', '--aspect', rule, '--ratify', '--by', by, '--reason', 'Admitted in review: every service keeps its work in the tracker, not in comments.'], dir);
}

function setStatus(dir: string, rule: string, status: string): void {
  const file = aspectFile(dir, rule, 'yg-aspect.yaml');
  writeFileSync(file, readFileSync(file, 'utf-8').replace(/^status: .*$/m, `status: ${status}`), 'utf-8');
}

describe.skipIf(!distExists)('CLI E2E — type law is admitted by the user', () => {
  it('1: under the setting, an enforced rule on a type with no ratification blocks; advisory, draft and unattached rules do not; without it nothing is asked', () => {
    const dir = project('reported');
    const off = project('reported-off', false);
    try {
      const run1 = run(['check', '--no-approve', '--json'], dir);
      expect(run1.status).not.toBe(0);
      const doc = parseJson(run1.stdout);
      const found = typeLaw(doc);
      expect(found.map((i) => i.aspect).sort()).toEqual([ENFORCED_LLM, ENFORCED].sort());
      for (const i of found) expect(i.severity).toBe('error');
      const one = expectIssue(doc, { code: 'type-law-unratified', aspect: ENFORCED }) as { what?: string };
      expect(one.what).toContain("node type 'service'");
      expect(JSON.stringify(one)).toContain(`yg log add --aspect ${ENFORCED} --ratify --by`);
      expectNoIssue(doc, { code: 'type-law-unratified', aspect: ADVISORY });
      expectNoIssue(doc, { code: 'type-law-unratified', aspect: DRAFT_NOWHERE });

      expect(typeLaw(check(off))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(off, { recursive: true, force: true });
    }
  });

  it('2: a ratification records who admitted which version on which types, and the finding goes away', () => {
    const dir = project('ratified');
    try {
      const added = ratify(dir, ENFORCED);
      expect(added.status, added.all).toBe(0);
      expect(added.stdout).toMatch(/Timestamp: \S+/);

      const log = readLog(dir, ENFORCED);
      expect(log.entries[0].ratified).toMatchObject({ types: ['service'], by: 'Jane Doe' });
      expect(log.entries[0].ratified?.version).toMatch(/^[0-9a-f]{16}$/);

      const doc = check(dir);
      expectNoIssue(doc, { code: 'type-law-unratified', aspect: ENFORCED });
      expectIssue(doc, { code: 'type-law-unratified', aspect: ENFORCED_LLM });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3: a ratification naming nobody, one for a rule no type reaches, and --ratify on another log are refused', () => {
    const dir = project('refused');
    try {
      const noBy = run(['log', 'add', '--aspect', ENFORCED, '--ratify', '--reason', 'Admitted.'], dir);
      expect(noBy.status).not.toBe(0);
      expectErrorCode(noBy.all, 'aspect-ratify-by-missing');

      const noType = run(['log', 'add', '--aspect', DRAFT_NOWHERE, '--ratify', '--by', 'Jane Doe', '--reason', 'Admitted.'], dir);
      expect(noType.status).not.toBe(0);
      expectErrorCode(noType.all, 'aspect-ratify-no-type');

      const onNode = run(['log', 'add', '--node', 'services/orders', '--ratify', '--reason', 'Admitted.'], dir);
      expect(onNode.status).not.toBe(0);
      expect(onNode.all).toContain('--ratify');

      // Nothing was written by any of them.
      expect(existsSync(aspectFile(dir, ENFORCED, 'log.md'))).toBe(false);
      expect(existsSync(aspectFile(dir, DRAFT_NOWHERE, 'log.md'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4: changing the rule voids the admission, and the finding says when the old version was admitted', () => {
    const dir = project('changed');
    try {
      expect(ratify(dir, ENFORCED).status).toBe(0);
      const at = readLog(dir, ENFORCED).entries[0].at;
      appendFileSync(aspectFile(dir, ENFORCED, 'check.mjs'), '\n// a stricter reading, same export\n', 'utf-8');

      const issue = expectIssue(check(dir), { code: 'type-law-unratified', aspect: ENFORCED }) as { what?: string };
      expect(issue.what).toContain(`last admitted at ${at}`);

      // A ratification of the new version clears it again.
      expect(ratify(dir, ENFORCED).status).toBe(0);
      expectNoIssue(check(dir), { code: 'type-law-unratified', aspect: ENFORCED });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5: a rule admitted while it ran as advice can be hardened to enforced without asking again', () => {
    const dir = project('hardening');
    try {
      expect(ratify(dir, ADVISORY).status).toBe(0);
      setStatus(dir, ADVISORY, 'enforced');
      expectNoIssue(check(dir), { code: 'type-law-unratified', aspect: ADVISORY });

      // The same hardening with no admission is reported.
      const other = project('hardening-unadmitted');
      try {
        setStatus(other, ADVISORY, 'enforced');
        expectIssue(check(other), { code: 'type-law-unratified', aspect: ADVISORY });
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('6: a rule implied by a rule the type lists reaches the type too', () => {
    const dir = project('implied');
    try {
      // The draft rule is attached nowhere; the enforced script rule now implies it.
      const implier = aspectFile(dir, ENFORCED, 'yg-aspect.yaml');
      writeFileSync(implier, `${readFileSync(implier, 'utf-8').trimEnd()}\nimplies:\n  - ${DRAFT_NOWHERE}\n`, 'utf-8');
      setStatus(dir, DRAFT_NOWHERE, 'advisory');
      // Implied under the default strictest inheritance, it stands enforced on the type.
      const issue = expectIssue(check(dir), { code: 'type-law-unratified', aspect: DRAFT_NOWHERE }) as { what?: string };
      expect(issue.what).toContain("'service'");
      expect(ratify(dir, DRAFT_NOWHERE).status).toBe(0);
      expect(readLog(dir, DRAFT_NOWHERE).entries[0].ratified?.types).toEqual(['service']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('7: only the committed file turns the requirement on or off; a local overlay cannot, and a wrong type is refused', () => {
    const dir = project('committed', false);
    try {
      // An overlay turning it on changes nothing: the setting is read from the committed file only.
      writeFileSync(path.join(dir, '.yggdrasil', 'yg-secrets.yaml'), 'type_law:\n  ratification: true\n', 'utf-8');
      expect(typeLaw(check(dir))).toEqual([]);

      appendFileSync(configFile(dir), '\ntype_law:\n  ratification: true\n', 'utf-8');
      writeFileSync(path.join(dir, '.yggdrasil', 'yg-secrets.yaml'), 'type_law:\n  ratification: false\n', 'utf-8');
      const armed = run(['check', '--no-approve', '--json'], dir);
      expect(armed.status).not.toBe(0);
      expect(typeLaw(parseJson(armed.stdout)).map((i) => i.severity)).toEqual(['error', 'error']);

      const wrongType = project('committed-wrong-type', false);
      try {
        appendFileSync(configFile(wrongType), '\ntype_law:\n  ratification: "yes"\n', 'utf-8');
        expectIssue(check(wrongType), { code: 'config-invalid' });
      } finally {
        rmSync(wrongType, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('8: yg init --upgrade records the law the graph had once, turns the requirement on, and never records again', () => {
    const dir = project('upgrade', false);
    try {
      const up = run(['init', '--upgrade'], dir);
      expect(up.status, up.all).toBe(0);
      expect(readFileSync(configFile(dir), 'utf-8')).toMatch(/type_law:\n\s+ratification: true/);

      for (const rule of [ENFORCED, ENFORCED_LLM]) {
        const first = readLog(dir, rule).entries[0];
        expect(first.ratified?.types).toEqual(['service']);
        expect(first.ratified?.by).toContain('yg init --upgrade');
      }
      expect(existsSync(aspectFile(dir, ADVISORY, 'log.md'))).toBe(false);
      expect(typeLaw(check(dir))).toEqual([]);

      // Law written after the upgrade is not grandfathered by running it again: it blocks.
      setStatus(dir, ADVISORY, 'enforced');
      const again = run(['init', '--upgrade'], dir);
      expect(again.status).toBe(0);
      expect(again.stdout).not.toContain('Recorded');
      expect(existsSync(aspectFile(dir, ADVISORY, 'log.md'))).toBe(false);
      const doc = check(dir);
      expect(typeLaw(doc).map((i) => [i.aspect, i.severity])).toEqual([[ADVISORY, 'error']]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('8b: a configuration that already says off is the owner\'s answer — the upgrade records nothing and leaves it', () => {
    const dir = project('upgrade-off', false);
    try {
      appendFileSync(configFile(dir), '\ntype_law:\n  ratification: false\n', 'utf-8');
      const up = run(['init', '--upgrade'], dir);
      expect(up.status, up.all).toBe(0);
      expect(up.stdout).not.toContain('Recorded');
      expect(readFileSync(configFile(dir), 'utf-8')).toMatch(/ratification: false/);
      expect(existsSync(aspectFile(dir, ENFORCED, 'log.md'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('9: a fresh project starts with the requirement on', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-typelaw-fresh-'));
    try {
      mkdirSync(path.join(dir, 'src'));
      const init = run(['init', '--no-reviewer'], dir);
      expect(init.status, init.all).toBe(0);
      expect(readFileSync(configFile(dir), 'utf-8')).toMatch(/type_law:\n\s+ratification: true/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
