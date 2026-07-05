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
// Hermetic E2E harness — yg-config.yaml reviewer/tier + global-config VALIDATION
// matrix through the spawned binary.
//
// Every test scaffolds a fresh minimal graph in a per-test mkdtemp directory:
//   - a single `service` node type whose `when` matches everything,
//   - ONE node and ONE DETERMINISTIC aspect (so the graph is structurally
//     complete and fully hermetic — no LLM, no network, no clock, no RNG),
//   - a yg-config.yaml exhibiting exactly ONE config defect per test.
//
// It then spawns the REAL built binary (dist/bin.js) running `yg check` and
// asserts exit code 1 + the SPECIFIC error code and message substrings. Every
// code/message asserted below was verified against the live binary AND against
// src/io/config-parser.ts / src/io/aspect-parser.ts /
// src/core/checks/aspect-contracts.ts before being pinned here.
//
// Determinism guarantees:
//   - `yg check` runs purely on the local graph + filesystem; no reviewer
//     endpoint is dialed. The valid-config baseline carries a loopback endpoint
//     that is never contacted.
//   - The committed fixtures under tests/fixtures/ are never mutated; every
//     config is authored in mkdtemp.
//   - Each temp dir is removed in a finally block.
//
// Coverage boundary (no overlap with existing suites):
//   - cli-check-validation.test.ts deliberately scaffolds a VALID config, so it
//     never fires any config-* code. This suite owns the config-defect matrix.
//   - cli-migrations.test.ts (M3) already covers the legacy v4→v5 rejection via
//     `yg init --upgrade` AND via `yg check`. Legacy/mixed config-shape
//     detection has been removed from the runtime parser — a malformed v5 config
//     yields `config-tiers-missing` or `config-reviewer-unknown-key`.
//   - cli-tier-cascade.test.ts covers tier-identity DRIFT/cascade, not config
//     VALIDATION errors. No overlap.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');

const distExists = existsSync(BIN_PATH);

// A loopback reviewer endpoint that is never dialed by `yg check`. Used only so
// a valid baseline config carries a syntactically valid tier — no test depends
// on this host being reachable or absent.
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
  const result = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/**
 * Scaffold a minimal, structurally-complete, fully-hermetic graph and write the
 * scenario's yg-config.yaml.
 *
 * `referenceAspect` controls whether the single node declares the deterministic
 * aspect. For pure CONFIG defects the aspect parses fine, so the node DOES
 * reference it (avoids an orphaned-aspect warning). For aspect-PARSE defects
 * (e.g. tier-on-deterministic) the offending aspect is dropped from the graph,
 * which would make a referencing node ALSO trip aspect-undefined — so the
 * caller leaves the node unreferenced to isolate the parse error.
 *
 * Returns the temp dir; caller is responsible for rmSync cleanup.
 */
function scaffold(
  label: string,
  opts: {
    configYaml: string;
    aspectYaml?: string;
    aspectRule?: { file: 'content.md' | 'check.mjs'; body: string };
    referenceAspect?: boolean;
    /**
     * Repo-relative mapping entries for the widget node. Only needed by
     * scenarios that require an effective (non-draft) pair to exist —
     * `computeExpectedPairs` skips any node with an empty mapping, so most
     * scenarios in this file (structural config validation) leave this unset.
     * When set, the caller is responsible for writing the mapped file(s).
     */
    mapping?: string[];
  },
): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-cfgtier-${label}-`));
  const ygRoot = path.join(dir, '.yggdrasil');
  mkdirSync(path.join(ygRoot, 'model', 'widget'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'aspects', 'det'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'flows'), { recursive: true });

  writeFileSync(
    path.join(ygRoot, 'yg-architecture.yaml'),
    [
      'node_types:',
      '  service:',
      "    description: 'A service'",
      '    log_required: false',
      '    when:',
      '      path: "**"',
      '',
    ].join('\n'),
    'utf-8',
  );

  const referenceAspect = opts.referenceAspect ?? true;
  writeFileSync(
    path.join(ygRoot, 'model', 'widget', 'yg-node.yaml'),
    [
      'name: Widget',
      'description: A widget node',
      'type: service',
      ...(referenceAspect ? ['aspects:', '  - det'] : []),
      ...(opts.mapping && opts.mapping.length > 0 ? ['mapping:', ...opts.mapping.map((m) => `  - ${m}`)] : []),
      '',
    ].join('\n'),
    'utf-8',
  );

  const aspectYaml =
    opts.aspectYaml ??
    ['name: Det', 'description: A deterministic aspect', 'reviewer:', '  type: deterministic', ''].join('\n');
  writeFileSync(path.join(ygRoot, 'aspects', 'det', 'yg-aspect.yaml'), aspectYaml, 'utf-8');
  const aspectRule = opts.aspectRule ?? { file: 'check.mjs', body: 'export function check() {\n  return [];\n}\n' };
  writeFileSync(path.join(ygRoot, 'aspects', 'det', aspectRule.file), aspectRule.body, 'utf-8');

  writeFileSync(path.join(ygRoot, 'yg-config.yaml'), opts.configYaml, 'utf-8');
  return dir;
}

/** A valid single-tier reviewer block — the baseline every defect mutates. */
const VALID_TIER = [
  '    standard:',
  '      provider: ollama',
  '      consensus: 1',
  '      config:',
  '        model: test',
  `        endpoint: ${LOOPBACK_ENDPOINT}`,
].join('\n');

describe.skipIf(!distExists)('CLI E2E — yg-config.yaml reviewer/tier + global-config validation matrix', () => {
  // =========================================================================
  // GROUP A — provider validation
  // =========================================================================

  it('A1: an unknown provider value yields config-tier-provider-unknown (exit 1)', () => {
    const dir = scaffold('provider-unknown', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: bogus-provider', '      consensus: 1', '      config:', '        model: test', ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-provider-unknown');
      // Per-issue `what` (the "unknown provider 'bogus-provider'" detail) is gone
      // from the grouped default view; assert the now-visible shared why + Fix.
      expect(stdout).toContain('provider must be one the CLI knows how to invoke');
      expect(stdout).toContain('Fix: use one of: ollama, openai, anthropic');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A2: a tier missing provider: yields config-tier-provider-missing (exit 1)', () => {
    const dir = scaffold('provider-missing', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      consensus: 1', '      config:', '        model: test', ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-provider-missing');
      // Per-tier `what` detail is gone from the grouped view; assert the shared why + Fix.
      expect(stdout).toContain('each tier must declare which provider implements it');
      expect(stdout).toContain("Fix: add 'provider: <one-of-known>'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP B — consensus validation (positive odd integer)
  // =========================================================================

  it('B1: an even consensus yields config-tier-consensus-invalid (exit 1)', () => {
    const dir = scaffold('consensus-even', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      consensus: 2', '      config:', '        model: test', `        endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-consensus-invalid');
      // The per-value `what` ("invalid consensus '2'") is gone from the grouped view;
      // assert the now-visible shared why + Fix that explains the odd-integer rule.
      expect(stdout).toContain('consensus must be a positive odd integer; even values cannot break ties');
      expect(stdout).toContain('Fix: use 1 (single call) or an odd number >= 3 for majority vote');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B2: a zero consensus yields config-tier-consensus-invalid (exit 1)', () => {
    const dir = scaffold('consensus-zero', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      consensus: 0', '      config:', '        model: test', `        endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-consensus-invalid');
      // The per-value `what` ("invalid consensus '0'") is gone from the grouped view;
      // assert the now-visible shared why + Fix that explains the < 1 rejection.
      expect(stdout).toContain('< 1 is nonsensical');
      expect(stdout).toContain('Fix: use 1 (single call) or an odd number >= 3 for majority vote');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B3: a negative consensus yields config-tier-consensus-invalid (exit 1)', () => {
    const dir = scaffold('consensus-neg', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      consensus: -3', '      config:', '        model: test', `        endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-consensus-invalid');
      // The per-value `what` ("invalid consensus '-3'") is gone from the grouped view;
      // assert the now-visible shared why + Fix that explains the < 1 rejection.
      expect(stdout).toContain('< 1 is nonsensical');
      expect(stdout).toContain('Fix: use 1 (single call) or an odd number >= 3 for majority vote');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B4: a non-integer consensus yields config-tier-consensus-invalid (exit 1)', () => {
    const dir = scaffold('consensus-float', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      consensus: 1.5', '      config:', '        model: test', `        endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-consensus-invalid');
      // The per-value `what` ("invalid consensus '1.5'") is gone from the grouped view;
      // assert the now-visible shared why + Fix that explains the integer rule.
      expect(stdout).toContain('consensus must be a positive odd integer');
      expect(stdout).toContain('Fix: use 1 (single call) or an odd number >= 3 for majority vote');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B5: a tier missing consensus: yields config-tier-consensus-invalid (exit 1)', () => {
    const dir = scaffold('consensus-missing', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      config:', '        model: test', `        endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-consensus-invalid');
      // The per-tier `what` ("tier 'standard' is missing consensus") is gone from the
      // grouped view; assert the now-visible shared why + Fix for the missing-key case.
      expect(stdout).toContain('consensus is the number of independent reviewer votes per aspect');
      expect(stdout).toContain('Fix: add `consensus: 1`');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP C — tier config block (model required, config block required)
  // =========================================================================

  it('C1: a tier missing config: yields config-tier-config-missing (exit 1)', () => {
    const dir = scaffold('config-missing', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      consensus: 1', ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-config-missing');
      // The per-tier `what` ("tier 'standard' is missing config") is gone from the
      // grouped view; assert the now-visible shared why + Fix for the missing-config case.
      expect(stdout).toContain('provider-specific settings live in config:');
      expect(stdout).toContain('Fix: add `config: { model: <model-name> }`');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C2: a tier whose config has no model yields config-tier-config-missing (exit 1)', () => {
    // ollama has no PROVIDER_DEFAULTS model fallback, so an absent config.model
    // surfaces as config-tier-config-missing ("config.model is missing").
    const dir = scaffold('model-missing', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      consensus: 1', '      config:', `        endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-config-missing');
      // The per-tier `what` ("config.model is missing") is gone from the grouped view;
      // assert the now-visible shared why + Fix for the missing-model case.
      expect(stdout).toContain('every tier requires a model id');
      expect(stdout).toContain('Fix: add `model: <model-name>` under config:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C3: an unknown key inside a tier yields config-tier-unknown-key (exit 1)', () => {
    const dir = scaffold('tier-unknown-key', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      consensus: 1', '      boguskey: 1', '      config:', '        model: test', `        endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-unknown-key');
      // The per-key `what` ("unknown key 'boguskey'") is gone from the grouped view;
      // assert the now-visible shared why + Fix listing the accepted tier keys.
      expect(stdout).toContain('tier accepts only `provider`, `consensus`, `config`, `max_prompt_chars`');
      expect(stdout).toContain("Fix: move to config: if it's a provider setting, or remove");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP D — tier names (regex + reserved)
  // =========================================================================

  it('D1: a tier name that fails the name regex yields config-tier-name-invalid (exit 1)', () => {
    // Tier names must match ^[a-zA-Z][a-zA-Z0-9_-]{0,62}$ — a leading digit is
    // rejected. default points at it so reviewer.default is itself valid.
    const dir = scaffold('tier-name-invalid', {
      configYaml: ['reviewer:', '  default: "1bad"', '  tiers:', '    "1bad":', '      provider: ollama', '      consensus: 1', '      config:', '        model: test', `        endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-name-invalid');
      // The per-name `what` ("tier name '1bad' is invalid") is gone from the grouped view;
      // assert the now-visible shared why + Fix (which carries the name-regex constraint).
      expect(stdout).toContain('tier names must start with a letter and contain only letters, digits, underscore, or hyphen');
      expect(stdout).toContain('Fix: rename the tier (regex: ^[a-zA-Z][a-zA-Z0-9_-]{0,62}$)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('D2: a tier literally named default yields config-tier-name-reserved (exit 1)', () => {
    const dir = scaffold('tier-name-reserved', {
      configYaml: ['reviewer:', '  tiers:', '    default:', '      provider: ollama', '      consensus: 1', '      config:', '        model: test', `        endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-name-reserved');
      // The per-name `what` ("tier name 'default' is reserved") is gone from the grouped
      // view; assert the now-visible shared why + Fix explaining the reserved name.
      expect(stdout).toContain('a tier named "default" is visually identical to reviewer.default pointing to itself');
      expect(stdout).toContain('Fix: rename the tier (referenced by aspects via reviewer.tier:)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP E — reviewer.default resolution
  // =========================================================================

  it('E1: multiple tiers with NO reviewer.default yields config-default-tier-missing (exit 1)', () => {
    const dir = scaffold('default-missing', {
      configYaml: [
        'reviewer:',
        '  tiers:',
        VALID_TIER,
        '    deep:',
        '      provider: anthropic',
        '      consensus: 1',
        '      config:',
        '        model: claude',
        '',
      ].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-default-tier-missing');
      // The per-issue `what` ("reviewer.default is required when multiple tiers are
      // configured") is gone from the grouped view; assert the now-visible why + Fix.
      expect(stdout).toContain('with multiple tiers, the default must be chosen explicitly');
      expect(stdout).toContain('Fix: set reviewer.default to one of: standard, deep');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E2: reviewer.default naming a non-existent tier yields config-default-tier-unknown (exit 1)', () => {
    const dir = scaffold('default-unknown', {
      configYaml: ['reviewer:', '  default: ghost', '  tiers:', VALID_TIER, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-default-tier-unknown');
      // The per-issue `what` ("reviewer.default is 'ghost' but no tier 'ghost' is
      // configured") is gone from the grouped view; assert the now-visible why + Fix.
      expect(stdout).toContain('reference must match a tier name');
      expect(stdout).toContain('Fix: use one of: standard');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP F — reviewer-section shape (missing, unknown key)
  // =========================================================================

  it('F1: a config with no reviewer: block yields config-reviewer-missing when an LLM pair is effective (exit 1)', () => {
    // A valid YAML mapping (quality only) but no reviewer section. This is a
    // validator-level check (checkReviewerPresence), not a parser throw, so it
    // is distinct from the empty-file config-invalid case (G2).
    //
    // checkReviewerPresence now fires only once a judgment (LLM) pair is
    // actually effective, so — unlike the rest of this file's deterministic-only
    // scenarios — this one needs the widget node mapped to a real source file
    // and the 'det' aspect reassigned to an LLM reviewer with content.md.
    const dir = scaffold('reviewer-missing', {
      configYaml: ['quality:', '  max_direct_relations: 10', ''].join('\n'),
      aspectYaml: ['name: Det', 'description: A judgment aspect', 'reviewer:', '  type: llm', ''].join('\n'),
      aspectRule: { file: 'content.md', body: '# Rule\n\nAlways pass.\n' },
      mapping: ['src/widget.ts'],
    });
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'widget.ts'), 'export const widget = 1;\n', 'utf-8');
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-reviewer-missing');
      // The per-issue `what` ("yg-config.yaml has no reviewer: section") is gone from the
      // grouped view; assert the now-visible shared why + Fix.
      expect(stdout).toContain('Script rules run locally for free');
      expect(stdout).toContain("Fix: Run yg init and pick 'Configure reviewer'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F1b: a config with no reviewer: block is silent when no LLM pair is effective (exit 0)', () => {
    // Same missing reviewer: section, but the default scaffold's single
    // aspect is deterministic and unmapped-file-free scenarios in this suite
    // never produce a pair — no judgment rule is effective, so a script-only
    // graph is a legal keyless state and config-reviewer-missing stays silent.
    const dir = scaffold('reviewer-missing-silent', {
      configYaml: ['quality:', '  max_direct_relations: 10', ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(stdout).not.toContain('config-reviewer-missing');
      expect(status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F2: an unknown key directly under reviewer: yields config-reviewer-unknown-key (exit 1)', () => {
    const dir = scaffold('reviewer-unknown-key', {
      configYaml: ['reviewer:', '  bogus: 1', '  tiers:', VALID_TIER, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-reviewer-unknown-key');
      // The per-key `what` ("unknown key 'bogus' under reviewer:") is gone from the
      // grouped view; assert the now-visible shared why + Fix.
      expect(stdout).toContain('the reviewer section accepts only `default` and `tiers`');
      expect(stdout).toContain("Fix: move provider-specific settings into a tier's config: section");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F3: a multi-tier config with an EMPTY tiers mapping yields config-tiers-empty (exit 1)', () => {
    // reviewer present with `tiers:` but no entries → current-shape intent with
    // an unmet structural requirement.
    const dir = scaffold('tiers-empty', {
      configYaml: ['reviewer:', '  tiers: {}', ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tiers-empty');
      // The per-issue `what` ("reviewer.tiers is empty") is gone from the grouped view;
      // assert the now-visible shared why + Fix.
      expect(stdout).toContain('at least one tier must be defined');
      expect(stdout).toContain('Fix: add at least one tier entry');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP G — top-level + global config (quality, parallel, empty file)
  // =========================================================================

  // RE-POINTED from `quality.max_node_chars` (removed) to the replacement
  // per-tier `max_prompt_chars` ceiling. The old node-byte budget and its
  // `config-invalid: quality.max_node_chars must be a positive integer` message
  // are gone (the key is now silently ignored). The prompt-size cap moved onto
  // the reviewer tier as `max_prompt_chars`, and a zero/negative/fractional value
  // there is rejected by config parsing with code config-tier-prompt-chars-invalid
  // — the same "a nonsensical positive-integer constraint is rejected" property
  // the original two cases proved, ported to the surviving surface.

  it('G1: a negative tier max_prompt_chars yields config-tier-prompt-chars-invalid (exit 1)', () => {
    const dir = scaffold('prompt-chars-neg', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      consensus: 1', '      max_prompt_chars: -5', '      config:', '        model: test', `        endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-prompt-chars-invalid');
      // The per-tier `what` ("tier 'standard' has invalid max_prompt_chars: -5") is gone
      // from the grouped view; assert the now-visible shared why + Fix that rejects
      // zero/negative/fractional values.
      expect(stdout).toContain('a zero, negative, or fractional value makes the gate nonsensical');
      expect(stdout).toContain("Fix: set 'max_prompt_chars' to a positive integer");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('G1b: a zero tier max_prompt_chars yields config-tier-prompt-chars-invalid (exit 1)', () => {
    const dir = scaffold('prompt-chars-zero', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      consensus: 1', '      max_prompt_chars: 0', '      config:', '        model: test', `        endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-prompt-chars-invalid');
      // The per-tier `what` ("tier 'standard' has invalid max_prompt_chars: 0") is gone
      // from the grouped view; assert the now-visible shared why + Fix that rejects
      // zero/negative/fractional values.
      expect(stdout).toContain('a zero, negative, or fractional value makes the gate nonsensical');
      expect(stdout).toContain("Fix: set 'max_prompt_chars' to a positive integer");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('G2: a negative parallel yields config-invalid (exit 1)', () => {
    const dir = scaffold('parallel-neg', {
      configYaml: ['parallel: -2', 'reviewer:', '  tiers:', VALID_TIER, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-invalid');
      // The per-issue `what` ("parallel must be a positive integer >= 1") is gone from
      // the grouped view; assert the now-visible why (which carries the < 1 rejection)
      // + Fix.
      expect(stdout).toContain('parallel controls the concurrent-aspect-verification cap; values < 1 cannot make progress');
      expect(stdout).toContain('Fix: set `parallel: <positive integer>`');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('G2b: a non-numeric parallel yields config-invalid (exit 1)', () => {
    const dir = scaffold('parallel-string', {
      configYaml: ['parallel: lots', 'reviewer:', '  tiers:', VALID_TIER, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-invalid');
      // The per-issue `what` ("parallel must be a number") is gone from the grouped view;
      // assert the now-visible why + Fix for the parallel-cap config defect.
      expect(stdout).toContain('parallel controls the concurrent-aspect-verification cap');
      expect(stdout).toContain('Fix: set `parallel: <positive integer>`');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('G3: an empty config file yields config-invalid (exit 1)', () => {
    const dir = scaffold('empty-config', { configYaml: '' });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-invalid');
      // The per-issue `what` ("empty or not a valid YAML mapping") is gone from the
      // grouped view; assert the now-visible why + Fix for the malformed-top-level case.
      expect(stdout).toContain('the top-level structure must be a YAML mapping with keys like reviewer, quality, parallel');
      expect(stdout).toContain('Fix: restore the file from version control, or regenerate it via `yg init`');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP H — aspect-side tier validation (config-adjacent)
  // =========================================================================

  it('H1: a deterministic aspect declaring reviewer.tier yields aspect-tier-on-deterministic (exit 1)', () => {
    // The offending aspect fails to parse and is dropped from the graph, so the
    // node must NOT reference it (otherwise aspect-undefined piles on). The bare
    // parse error is then isolated; the orphaned-aspect warning is non-blocking.
    const dir = scaffold('tier-on-det', {
      configYaml: ['reviewer:', '  tiers:', VALID_TIER, ''].join('\n'),
      aspectYaml: [
        'name: Det',
        'description: A deterministic aspect that wrongly declares a tier',
        'reviewer:',
        '  type: deterministic',
        '  tier: standard',
        '',
      ].join('\n'),
      referenceAspect: false,
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('aspect-tier-on-deterministic');
      // The per-aspect `what` ("reviewer.type: deterministic together with
      // reviewer.tier: 'standard'") is gone from the grouped view; assert the now-visible
      // why + Fix that explains why tiers do not apply to deterministic aspects.
      expect(stdout).toContain('Deterministic aspects run locally without an LLM; tiers do not apply');
      expect(stdout).toContain('Fix: remove tier: from the aspect');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP I — omitted max_prompt_chars defaults to 50000 (the §4 gate is
  // unconditional). A tier that leaves the key out still gates oversized prompts.
  // =========================================================================

  it('I1: a tier OMITTING max_prompt_chars still gates an oversized LLM prompt at the 50000 default (exit 1)', () => {
    // The shared scaffold() writes NO mapping and NO source file, so an LLM aspect
    // would form ZERO pairs and `yg check` would pass vacuously. This test therefore
    // builds a node WITH a mapping, an oversized source file, and an LLM aspect so a
    // real LLM pair forms — mirroring cli-scope-toolarge.test.ts. The tier omits
    // max_prompt_chars; the assembled prompt (~60k chars) exceeds the 50000 default,
    // so plain `yg check` (no --approve, no reviewer call) reports prompt-too-large.
    const dir = scaffold('prompt-chars-default-gate', {
      // Tier omits max_prompt_chars entirely.
      configYaml: ['reviewer:', '  tiers:', VALID_TIER, ''].join('\n'),
      // LLM aspect (reviewer.type: llm + content.md) so a billable LLM pair forms.
      aspectYaml: ['name: Det', 'description: An LLM aspect over every file', 'reviewer:', '  type: llm', ''].join('\n'),
      aspectRule: { file: 'content.md', body: 'Every file must satisfy the rule.\n' },
    });
    try {
      const ygRoot = path.join(dir, '.yggdrasil');
      // Give the node a real mapping + an oversized source file so a non-vacuous LLM
      // pair forms whose assembled prompt exceeds the 50000 default.
      mkdirSync(path.join(dir, 'src'), { recursive: true });
      writeFileSync(path.join(dir, 'src', 'big.ts'), 'a'.repeat(60_000), 'utf-8');
      writeFileSync(
        path.join(ygRoot, 'model', 'widget', 'yg-node.yaml'),
        ['name: Widget', 'description: A widget node', 'type: service', 'mapping:', '  - src/big.ts', 'aspects:', '  - det', ''].join('\n'),
        'utf-8',
      );

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      // The §4 gate fired at the DEFAULT limit even though the tier omitted the key.
      // prompt-too-large is NOT a FULL_WHAT code, so the per-node `what` carrying the
      // explicit "50000" limit is gone from the grouped default view. Assert the now-
      // visible group content proving an LLM pair was actually gated: the group label,
      // the aspect segment (only aspect-bearing issues carry it), the shared why, and
      // the member node line.
      expect(stdout).toContain('prompt-too-large');
      expect(stdout).toContain("aspect 'det'");
      expect(stdout).toContain('An over-limit prompt risks context-window truncation and a false verdict');
      expect(stdout).toContain('- widget');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('H2: an LLM aspect referencing a non-existent tier yields aspect-tier-unknown (exit 1)', () => {
    // The aspect PARSES fine (an unknown tier reference is not a parse error),
    // so the node references it and the validator-level checkAspectTierReferences
    // fires. The hermetic deterministic `det` aspect is replaced by an LLM aspect
    // pointing at a tier that is not configured.
    const dir = scaffold('aspect-tier-unknown', {
      configYaml: ['reviewer:', '  tiers:', VALID_TIER, ''].join('\n'),
      aspectYaml: [
        'name: Det',
        'description: An LLM aspect referencing a missing tier',
        'reviewer:',
        '  type: llm',
        '  tier: ghosttier',
        '',
      ].join('\n'),
      aspectRule: { file: 'content.md', body: 'Some rule.\n' },
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('aspect-tier-unknown');
      // The per-aspect `what` ("references tier 'ghosttier' that does not exist") is gone
      // from the grouped view; assert the now-visible shared why + Fix.
      expect(stdout).toContain('Every tier reference must match a configured tier name under reviewer.tiers');
      expect(stdout).toContain("Fix: Use one of: standard, or remove 'tier:'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
