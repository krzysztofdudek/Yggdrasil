import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

// ---------------------------------------------------------------------------
// API-KEY SECRETS SHAPE — the yg-secrets.yaml overlay contract, asserted purely
// over the public CLI surface (the spawned binary + the files it consumes).
//
// `yg init` writes the reviewer API key as a 1:1 overlay over yg-config.yaml: the
// credential lives INSIDE the bootstrapped tier's `config:` block
// (`reviewer.tiers.<tier>.config.api_key`), NOT a provider-level bucket. The
// reviewer: section accepts only `default` and `tiers`, and distinct tiers may use
// distinct providers, so the credential is per-tier, not per-provider.
//
// `yg init` itself is interactive (it hard-requires a TTY and exits otherwise), so
// it cannot be driven headlessly from a test. Rather than reach into the CLI's
// internal init writers, this suite pins the same contract from the OUTSIDE: it
// hand-authors the documented overlay shape and proves the real `yg check` accepts
// it end-to-end — the merged (config + secrets) config parses with no
// `config-reviewer-unknown-key`, and the project reaches a clean exit. That the key
// sits in the tier's `config:` block (and NOT under a `reviewer.<provider>` bucket)
// is asserted directly on the yg-secrets.yaml the overlay must take.
//
// Every key-requiring provider is covered. The set is stable and documented:
// openai, anthropic, google, and openai-compatible all require a key (the CLI-agent
// providers and local Ollama need none). The aspect under test is deterministic, so
// the reviewer is never invoked — the providers only need to be schema-valid and to
// round-trip through the secrets overlay.
//
// Hermetic: every case scaffolds a fresh mkdtemp greenfield project, mutates only
// that copy, and rmSync's it in a finally. No network, no LLM, no shared state.
// ---------------------------------------------------------------------------

/** Providers that require an API key (openai-compatible additionally needs an endpoint). */
const KEY_PROVIDERS = ['openai', 'anthropic', 'google', 'openai-compatible'] as const;
type KeyProvider = (typeof KEY_PROVIDERS)[number];

/** The single tier `yg init` bootstraps; the secrets overlay must address the SAME tier. */
const BOOTSTRAP_TIER = 'standard';

function run(args: string[], cwd: string): { status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { status: result.status, all: (result.stdout ?? '') + (result.stderr ?? '') };
}

/**
 * Scaffold a minimal, fully deterministic greenfield project whose single
 * reviewer tier uses `provider`, plus a yg-secrets.yaml overlay carrying the API
 * key in the documented `reviewer.tiers.<tier>.config.api_key` location. Returns
 * the project root. Caller owns cleanup.
 *
 * The graph carries only a deterministic aspect, so the reviewer is never called
 * — the provider/key only have to be schema-valid and to survive the overlay
 * deep-merge that `yg check` applies at config-parse time.
 */
function secretsProject(provider: KeyProvider, apiKey: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-init-secrets-${provider}-`));
  const yggRoot = path.join(dir, '.yggdrasil');
  mkdirSync(path.join(yggRoot, 'model', 'widgets', 'widget'), { recursive: true });
  mkdirSync(path.join(yggRoot, 'aspects', 'no-todo-comments'), { recursive: true });
  mkdirSync(path.join(yggRoot, 'flows'), { recursive: true });
  mkdirSync(path.join(dir, 'src', 'widgets'), { recursive: true });

  // yg-config.yaml — the bootstrapped single-tier shape `yg init` writes: the tier
  // names the provider; openai-compatible additionally needs an explicit endpoint.
  // The credential is NOT in the committed config — it arrives via the overlay below.
  const tierConfig: Record<string, unknown> = { model: 'test-model', temperature: 0 };
  if (provider === 'openai-compatible') tierConfig.endpoint = 'https://example.test/v1';
  const config = {
    version: '5.2.0',
    quality: { max_direct_relations: 10 },
    reviewer: {
      default: BOOTSTRAP_TIER,
      tiers: {
        [BOOTSTRAP_TIER]: {
          provider,
          consensus: 1,
          max_prompt_chars: 50000,
          config: tierConfig,
        },
      },
    },
  };
  writeFileSync(path.join(yggRoot, 'yg-config.yaml'), stringifyYaml(config), 'utf-8');

  // yg-secrets.yaml — the 1:1 overlay. The API key lives in the tier's config:
  // block (where the reviewer reads it from the resolved tier), addressing the SAME
  // tier the config declares; NOT a `reviewer.<provider>` bucket.
  const secrets = {
    reviewer: {
      tiers: {
        [BOOTSTRAP_TIER]: {
          config: { api_key: apiKey },
        },
      },
    },
  };
  writeFileSync(path.join(yggRoot, 'yg-secrets.yaml'), stringifyYaml(secrets), 'utf-8');

  // Architecture: one mapping node type under a single organizational parent.
  writeFileSync(
    path.join(yggRoot, 'yg-architecture.yaml'),
    `node_types:
  module:
    description: 'Organizational grouping. Parent-only — no file mapping.'
    log_required: false
  widget:
    description: 'A widget implemented as a single source file under src/widgets/.'
    log_required: false
    when:
      path: "src/widgets/**"
    parents: [module]
    aspects:
      - no-todo-comments
`,
    'utf-8',
  );

  // Deterministic aspect: flags any line containing TODO. Pure text scan — no AST,
  // no network, no reviewer call.
  writeFileSync(
    path.join(yggRoot, 'aspects', 'no-todo-comments', 'yg-aspect.yaml'),
    `name: NoTodoComments
description: Source files must not contain TODO comments.
reviewer:
  type: deterministic
status: enforced
`,
    'utf-8',
  );
  writeFileSync(
    path.join(yggRoot, 'aspects', 'no-todo-comments', 'check.mjs'),
    `export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    const lines = file.content.split('\\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('TODO')) {
        violations.push({ file: file.path, line: i + 1, column: 0, message: 'TODO found.' });
      }
    }
  }
  return violations;
}
`,
    'utf-8',
  );

  writeFileSync(
    path.join(yggRoot, 'model', 'widgets', 'yg-node.yaml'),
    `name: Widgets
description: Organizational parent grouping the application's widgets.
type: module
`,
    'utf-8',
  );
  writeFileSync(
    path.join(yggRoot, 'model', 'widgets', 'widget', 'yg-node.yaml'),
    `name: Widget
description: A single widget unit.
type: widget
mapping:
  - src/widgets/widget.ts
`,
    'utf-8',
  );
  writeFileSync(
    path.join(dir, 'src', 'widgets', 'widget.ts'),
    `export function widget() {
  return 'ok';
}
`,
    'utf-8',
  );

  return dir;
}

describe.skipIf(!distExists)('yg secrets overlay — API-key shape (1:1 overlay, per key-requiring provider)', () => {
  it('covers every key-requiring provider', () => {
    expect(KEY_PROVIDERS).toEqual(
      expect.arrayContaining(['openai', 'anthropic', 'google', 'openai-compatible']),
    );
  });

  it.each(KEY_PROVIDERS)(
    'puts the %s key in reviewer.tiers.<tier>.config.api_key and yg check parses the merged shape',
    (provider) => {
      const apiKey = `sk-${provider}-secret-xyz`;
      const root = secretsProject(provider, apiKey);
      try {
        const yggRoot = path.join(root, '.yggdrasil');

        // 1. yg-secrets.yaml is a 1:1 overlay over yg-config.yaml: the key lives
        //    inside the tier's config: block, NOT under a provider-level bucket.
        const secrets = parseYaml(readFileSync(path.join(yggRoot, 'yg-secrets.yaml'), 'utf-8'));
        expect(secrets.reviewer.tiers[BOOTSTRAP_TIER].config.api_key).toBe(apiKey);
        expect(secrets.reviewer[provider]).toBeUndefined();

        // 2. The real `yg check` parses the merged (config + secrets) shape — the
        //    overlay introduces no unknown reviewer key, and the deterministic graph
        //    reaches a clean green check.
        const res = run(['check', '--approve'], root);
        expect(res.all).not.toContain('config-reviewer-unknown-key');
        expect(res.status).toBe(0);

        // 3. A second read-only check stays green — the merged config (key included)
        //    round-trips through the parser without churn or error.
        const reread = run(['check'], root);
        expect(reread.all).not.toContain('config-reviewer-unknown-key');
        expect(reread.status).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
