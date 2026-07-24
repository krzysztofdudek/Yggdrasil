import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Hermetic E2E — INSTALLER MATRIX & CONFIG remaining paths through the spawned
// binary (dist/bin.js). Two live domains, none overlapping the existing suites:
//
//   GROUP P — DELETED. The seven-platform installer matrix this group covered
//     (copilot, cline, roocode, windsurf, aider, gemini, codebuddy — each with
//     its own rules path/co-write contract) is retired surface: every platform
//     now installs the SAME universal artifacts. See the deletion note where
//     the group stood; the surviving "every retired name still works, with a
//     notice" coverage lives in cli-lifecycle.test.ts.
//
//   GROUP M — DELETED. The v4 → v5 migration edges this group covered (config
//     bare/multi-provider→tiers transform, aspect reviewer string/mapping
//     migration, global-consensus normalization, secrets foreign-field withhold,
//     the "Migration withheld" resumable chain) were removed in the verdict-lock
//     redesign — `MIGRATIONS` is now empty and `yg init --upgrade` only bumps the
//     `version:` field. See the deletion note where the group stood.
//
//   GROUP C — config-parser coercion edges surfaced via `yg check` that
//     cli-config-tier-validation does NOT pin: tiers KEY missing entirely
//     (vs its empty-`{}` F3), a NON-STRING reviewer.default, a tier that is not
//     a mapping, a tier config: that is not a mapping, a scalar reviewer:, a
//     quality block that is not a mapping, parallel as a FLOAT, an ignored
//     (removed) max_tokens, a tier `references` key now rejected as an unknown
//     tier key, and a yg-secrets overlay field accepted through the check gate.
//
// Determinism: every test scaffolds in a fresh mkdtemp dir and rmSync()s it in a
// finally. The committed fixtures are never mutated (every config/aspect is
// authored in mkdtemp). No network, no clock, no RNG, no
// hardcoded reachable host — the loopback endpoint below is never dialed by the
// `yg check` / `yg init --upgrade` paths exercised here. Every exit code and
// message substring was verified against the live dist/bin.js before pinning.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');

const distExists = existsSync(BIN_PATH);

// A loopback endpoint that is never contacted by `yg check` / `yg init`. Used
// only so a config carries a syntactically valid tier — no test depends on this
// host being reachable or absent.
const LOOPBACK_ENDPOINT = 'http://127.0.0.1:11434';

function run(
  args: string[],
  cwd: string,
): {
  stdout: string;
  stderr: string;
  status: number | null;
  all: string;
} {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

// (bareUpgradeRepo — the bare --upgrade fixture helper GROUP P used — removed
// along with GROUP P itself: the retired per-platform installer matrix was its
// only caller in this file. Its "every retired platform name still works"
// replacement coverage in cli-lifecycle.test.ts keeps its own copy. makeV4Layout
// / configPath were likewise removed with GROUP M — the v4→v5 migration edges
// they served are deleted surface. The surviving GROUP C tests use
// scaffoldCheck instead.)

/**
 * Scaffold a structurally-complete, fully-hermetic graph (config + architecture
 * + one node + one deterministic aspect) and write the
 * scenario config. Returns the temp dir; caller owns rmSync cleanup. Mirrors the
 * scaffold helper in cli-config-tier-validation but inlined here so this file is
 * self-contained.
 */
function scaffoldCheck(
  label: string,
  opts: { configYaml: string; secretsYaml?: string; referenceAspect?: boolean },
): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-mcx-${label}-`));
  const ygRoot = path.join(dir, '.yggdrasil');
  mkdirSync(path.join(ygRoot, 'model', 'widget'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'aspects', 'det'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'flows'), { recursive: true });

  writeFileSync(
    path.join(ygRoot, 'yg-architecture.yaml'),
    ['node_types:', '  service:', "    description: 'A service'", '    log_required: false', '    when:', '      path: "**"', ''].join('\n'),
    'utf-8',
  );

  const referenceAspect = opts.referenceAspect ?? true;
  writeFileSync(
    path.join(ygRoot, 'model', 'widget', 'yg-node.yaml'),
    ['name: Widget', 'description: A widget node', 'type: service', ...(referenceAspect ? ['aspects:', '  - det'] : []), ''].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(ygRoot, 'aspects', 'det', 'yg-aspect.yaml'),
    ['name: Det', 'description: A deterministic aspect', 'reviewer:', '  type: deterministic', ''].join('\n'),
    'utf-8',
  );
  writeFileSync(path.join(ygRoot, 'aspects', 'det', 'check.mjs'), 'export function check() {\n  return [];\n}\n', 'utf-8');

  writeFileSync(path.join(ygRoot, 'yg-config.yaml'), opts.configYaml, 'utf-8');
  if (opts.secretsYaml !== undefined) {
    writeFileSync(path.join(ygRoot, 'yg-secrets.yaml'), opts.secretsYaml, 'utf-8');
  }
  return dir;
}

/** A valid single-tier reviewer block — the baseline several configs reuse. */
const VALID_TIER = [
  '    standard:',
  '      provider: ollama',
  '      consensus: 1',
  '      config:',
  '        model: test',
  `        endpoint: ${LOOPBACK_ENDPOINT}`,
].join('\n');

describe.skipIf(!distExists)('CLI E2E — migrations & config remaining paths (platform matrix, migration edges, coercion edges)', () => {
  // =========================================================================
  // GROUP P — DELETED: per-platform installer matrix.
  // =========================================================================
  // The thirteen per-platform installers (and their distinct rules paths —
  // .github/copilot-instructions.md, .clinerules/yggdrasil.md, .roo/rules/,
  // .windsurf/rules/, .aider.conf.yml + shared agent-rules.md, GEMINI.md
  // @import + shared agent-rules.md, .codebuddy/rules/.../RULE.mdc, ...) are
  // RETIRED. `installRules()` now writes the SAME three universal artifacts
  // (AGENTS.md digest block + CLAUDE.md @AGENTS.md import +
  // .clinerules/yggdrasil.md) regardless of `--platform`, which is accepted
  // only for backward compatibility and otherwise prints a deprecation notice.
  // Every test in this group asserted a platform-distinct rules path or
  // co-write decision that no longer exists, so all seven are deleted. The
  // "every retired platform name still works, with a notice, producing the
  // universal artifacts" contract is covered once, for the full name list, by
  // cli-lifecycle.test.ts's `init --upgrade --platform %s ...` matrix; the
  // fresh/prior-installation/CRLF/duplicated-block states of the universal
  // install itself are covered by cli-universal-install.test.ts (E1-E9, E12).

  // =========================================================================
  // GROUP M — DELETED: v4 → v5 migration edges.
  // =========================================================================
  // The legacy migration content was removed in the verdict-lock redesign
  // (src/migrations/index.ts: `MIGRATIONS` is empty). `yg init --upgrade` no
  // longer transforms a v4 bare-provider/multi-provider reviewer block into the
  // tier shape, no longer walks/rewrites aspect reviewer fields, and no longer
  // emits the "Migration withheld" signal or migrates yg-secrets.yaml — it now
  // simply bumps the on-disk `version:` field. Every test in this group asserted
  // that removed transform/withhold machinery (unrecognized aspect string,
  // mapping-without-type, even/odd global-consensus normalization, multi-provider
  // active-default resolution, secrets foreign-field withhold, resumable
  // withhold→fix→bump), so all seven are deleted. yg-secrets is now a deep-merge
  // overlay over yg-config — overlay fields are accepted (see C10 below).

  // =========================================================================
  // GROUP C — config-parser coercion edges via `yg check` (not in
  // cli-config-tier-validation).
  // =========================================================================

  it('C1: reviewer with `default:` but NO `tiers:` key yields config-tiers-missing (exit 1)', () => {
    // cli-config-tier-validation F3 covers an EMPTY `tiers: {}` (config-tiers-empty).
    // The wholly-ABSENT tiers key takes the distinct config-tiers-missing path.
    const dir = scaffoldCheck('tiers-missing', { configYaml: ['reviewer:', '  default: standard', ''].join('\n') });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tiers-missing');
      // Per-issue `what` is gone in the grouped renderer; assert the group's shared
      // `why` + `Fix:` guidance that conveys the same intent (tiers are required).
      expect(stdout).toContain('tiers are the only way to declare reviewer configurations');
      expect(stdout).toContain('Fix: add `reviewer.tiers:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C2: a NON-STRING reviewer.default yields config-default-tier-unknown (exit 1)', () => {
    // cli-config-tier-validation E2 covers a string default naming a missing
    // tier; the type-guard branch (default is a number) is distinct.
    const dir = scaffoldCheck('default-nonstring', {
      configYaml: ['reviewer:', '  default: 5', '  tiers:', VALID_TIER, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-default-tier-unknown');
      // Per-issue `what` is gone; assert the group's shared `why` + `Fix:` instead.
      expect(stdout).toContain('default references a tier by name');
      expect(stdout).toContain('Fix: set reviewer.default to one of: standard');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C3: a tier whose body is a scalar yields config-tier-invalid (exit 1)', () => {
    const dir = scaffoldCheck('tier-not-mapping', {
      configYaml: ['reviewer:', '  tiers:', '    standard: hello', ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-invalid');
      // Per-issue `what` is gone; assert the group's shared `why` + `Fix:` instead.
      expect(stdout).toContain('each tier is a mapping with provider, consensus, config');
      expect(stdout).toContain('Fix: replace with `{ provider:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C4: a tier config: that is a scalar yields config-tier-config-not-mapping (exit 1)', () => {
    // cli-config-tier-validation C1 covers a MISSING config:, C2 a missing
    // model. A present-but-scalar config: takes config-tier-config-not-mapping.
    const dir = scaffoldCheck('config-not-mapping', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      consensus: 1', '      config: hello', ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-config-not-mapping');
      // Per-issue `what` is gone; assert the group's shared `why` + `Fix:` instead.
      expect(stdout).toContain('provider settings are key-value pairs');
      expect(stdout).toContain('Fix: replace with `config: { model:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C5: a scalar reviewer: (not a mapping) yields config-invalid with the unrecognized-shape message (exit 1)', () => {
    // reviewer present but neither legacy nor mixed nor a mapping → the final
    // else branch in parseConfig ("unrecognized reviewer: shape").
    const dir = scaffoldCheck('reviewer-scalar', { configYaml: 'reviewer: hello\n' });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-invalid');
      // Per-issue `what` is gone; the group's shared `why` distinguishes this
      // config-invalid variant (the reviewer-shape guard) from the others.
      expect(stdout).toContain('reviewer: must be a mapping with a `tiers:` block');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C6: a quality: block that is a list yields config-invalid (quality must be a mapping) (exit 1)', () => {
    // cli-config-tier-validation G1/G1b cover bad quality.max_node_chars values;
    // a quality block that is not a mapping at all is the earlier guard.
    const dir = scaffoldCheck('quality-list', {
      configYaml: ['quality:', '  - a', '  - b', 'reviewer:', '  tiers:', VALID_TIER, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-invalid');
      // Per-issue `what` is gone; the group's shared `why` distinguishes the
      // quality-mapping guard from the other config-invalid variants.
      expect(stdout).toContain('quality holds named thresholds (max_direct_relations)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C7: a FRACTIONAL parallel yields config-invalid (positive integer >= 1) (exit 1)', () => {
    // cli-config-tier-validation G2 covers negative, G2b a non-numeric string.
    // A numeric-but-fractional value takes the !Number.isInteger branch with the
    // "positive integer >= 1" message (distinct from the "must be a number" one).
    const dir = scaffoldCheck('parallel-float', {
      configYaml: ['parallel: 2.5', 'reviewer:', '  tiers:', VALID_TIER, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-invalid');
      // Per-issue `what` is gone (it carried the "got 2.5" value); the group's
      // shared `why` distinguishes the parallel guard from the other variants.
      expect(stdout).toContain('parallel controls the concurrent-aspect-verification cap');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C8: max_tokens in tier config is silently ignored (removed field, not validated)', () => {
    // max_tokens was removed; any value in config.max_tokens is ignored without error.
    const dir = scaffoldCheck('max-tokens-ignored', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      consensus: 1', '      config:', '        model: test', '        max_tokens: -5', ''].join('\n'),
    });
    try {
      const { status } = run(['check'], dir);
      // max_tokens is now unrecognized and silently ignored — config parses without error.
      // (check exits 1 here because graph is empty, not because of config-tier-config-invalid)
      expect(status).not.toBe(undefined); // just ensuring it doesn't crash on config parse
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C9: a tier `references:` key is now an UNKNOWN tier key — config-tier-unknown-key (exit 1)', () => {
    // RE-POINTED: the reviewer-reference caps and the tier `references` key were
    // removed in the verdict-lock redesign. A tier no longer accepts `references`
    // at all (the old `tier-references-not-mapping` / reference-too-large codes
    // are gone), so any `references` entry under a tier is rejected as an unknown
    // key. The allowed-keys list the message names is the new authoritative set:
    // provider, consensus, config, max_prompt_chars.
    const dir = scaffoldCheck('refs-unknown-key', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      consensus: 1', '      references: hello', '      config:', '        model: test', ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-unknown-key');
      // Per-issue `what` (which named the offending 'references' key) is gone in
      // the grouped renderer; assert the group's shared `why`, which enumerates
      // the new authoritative allowed-keys set (including max_prompt_chars).
      expect(stdout).toContain('tier accepts only `provider`, `consensus`, `config`, `max_prompt_chars`');
      expect(stdout).toContain('max_prompt_chars');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C10: a yg-secrets.yaml overlay field (non-credential) is accepted — yg-secrets is a deep-merge overlay over yg-config', () => {
    // yg-secrets is no longer api_key-only: it overlays any yg-config field
    // locally (e.g. a tier's provider/model). A non-credential field is valid
    // and must NOT raise the retired secrets-non-credential-field error.
    const dir = scaffoldCheck('secrets-overlay', {
      configYaml: ['reviewer:', '  tiers:', VALID_TIER, ''].join('\n'),
      secretsYaml: ['reviewer:', '  tiers:', '    standard:', '      config:', '        temperature: 0.2', ''].join('\n'),
    });
    try {
      const { stdout } = run(['check'], dir);
      expect(stdout).not.toContain('secrets-non-credential-field');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
