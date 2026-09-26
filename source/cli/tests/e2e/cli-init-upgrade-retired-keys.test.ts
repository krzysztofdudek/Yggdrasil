// =============================================================================
// CLI E2E — `yg init --upgrade` removes the keys earlier releases read.
//
// A graph carried forward from 5.x still holds fields no release reads any more
// (a node's and a node type's `sizeExempt`, `quality.max_node_chars`, a tier's
// `max_tokens`, a relation's `failure`, a rule's `stability` / `language` /
// `id`). They used to be ignored; now every file refuses a key it does not
// accept, so without help such a graph goes red the moment it upgrades. The
// upgrade removes exactly the retired keys — naming each one it removes, keeping
// the rest of every file, comments included — and leaves any key nobody retired
// for the owner to correct, since guessing what a typo meant would be worse than
// naming it.
//
//   1. a 5.x-shaped graph → every retired key removed and named, comments kept,
//      and the next `yg check` reports no unknown key and no architecture-invalid
//   2. a key nobody retired → left in place, still named by `yg check`
//   3. a rule installed from a package → its files are never edited
//   4. a second upgrade → removes nothing (idempotent)
//
// Every repository is built at test time; nothing reaches the network, and no
// reviewer is called (the rules are script rules, and nothing is filled).
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_RM_OPTIONS, runGitFixture } from '../support/git-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { status: number | null; all: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  return { status: r.status, all: (r.stdout ?? '') + (r.stderr ?? '') };
}

/** A graph shaped like one last written by a 5.0 release, with the fields that release still read. */
const LEGACY: Record<string, string> = {
  '.yggdrasil/yg-config.yaml': [
    'version: 5.0.0',
    '# thresholds the team agreed on',
    'quality:',
    '  max_direct_relations: 10',
    '  max_node_chars: 40000',
    'debug: false',
    'reviewer:',
    '  tiers:',
    '    standard:',
    '      provider: claude-code',
    '      consensus: 1',
    '      config:',
    '        model: sonnet',
    '        max_tokens: 4096',
    '',
  ].join('\n'),
  '.yggdrasil/yg-architecture.yaml': [
    '# the app graph',
    'node_types:',
    '  module:',
    '    description: "Organizational grouping."',
    '  entity:',
    '    description: "A data model file."',
    '    sizeExempt:',
    '      reason: "Schemas are one file."',
    '    when:',
    '      path: "src/**"',
    '    parents: [module]',
    '',
  ].join('\n'),
  '.yggdrasil/model/app/yg-node.yaml': 'name: App\ntype: module\ndescription: The application.\n',
  '.yggdrasil/model/app/schema/yg-node.yaml': [
    'name: Schema',
    'type: entity',
    'description: "The data model."  # the one model file',
    'aspects:',
    '  - no-todo',
    'sizeExempt:',
    '  reason: "A single unsplittable model file."',
    'relations:',
    '  - target: app/other',
    '    type: uses',
    '    failure: retry',
    'mapping:',
    '  - src/schema.ts',
    '',
  ].join('\n'),
  '.yggdrasil/model/app/other/yg-node.yaml': 'name: Other\ntype: entity\ndescription: Another model.\nmapping:\n  - src/other.ts\n',
  '.yggdrasil/aspects/no-todo/yg-aspect.yaml': [
    'name: NoTodo',
    'id: no-todo',
    'description: "No TODO markers in shipped code."',
    'reviewer:',
    '  type: deterministic',
    'stability: protocol',
    'language: [typescript]',
    '',
  ].join('\n'),
  '.yggdrasil/aspects/no-todo/check.mjs': 'export function check() { return []; }\n',
  'src/schema.ts': 'export const schema = 1;\n',
  'src/other.ts': 'export const other = 1;\n',
};

function build(label: string, extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-retired-${label}-`));
  for (const [rel, body] of Object.entries({ ...LEGACY, ...extra })) {
    const abs = path.join(dir, ...rel.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf-8');
  }
  runGitFixture(dir, ['init', '-q']);
  return dir;
}

const read = (dir: string, rel: string): string => readFileSync(path.join(dir, ...rel.split('/')), 'utf-8');

describe.skipIf(!distExists)('CLI E2E — yg init --upgrade removes retired keys', () => {
  it('1: removes every retired key, names each one, keeps the rest, and the next check has no unknown key', () => {
    const dir = build('legacy');
    try {
      const upgraded = run(['init', '--upgrade'], dir);
      expect(upgraded.status).toBe(0);
      for (const line of [
        "Removed retired key 'quality.max_node_chars' from .yggdrasil/yg-config.yaml",
        "Removed retired key 'reviewer.tiers.standard.config.max_tokens' from .yggdrasil/yg-config.yaml",
        "Removed retired key 'node_types.entity.sizeExempt' from .yggdrasil/yg-architecture.yaml",
        "Removed retired key 'sizeExempt' from .yggdrasil/model/app/schema/yg-node.yaml",
        "Removed retired key 'relations[0].failure' from .yggdrasil/model/app/schema/yg-node.yaml",
        "Removed retired key 'id' from .yggdrasil/aspects/no-todo/yg-aspect.yaml",
        "Removed retired key 'stability' from .yggdrasil/aspects/no-todo/yg-aspect.yaml",
        "Removed retired key 'language' from .yggdrasil/aspects/no-todo/yg-aspect.yaml",
      ]) {
        expect(upgraded.all).toContain(line);
      }
      expect(upgraded.all).toContain('Review with git diff before committing.');

      // Everything else stays, comments included.
      const config = read(dir, '.yggdrasil/yg-config.yaml');
      expect(config).not.toContain('max_node_chars');
      expect(config).not.toContain('max_tokens');
      expect(config).toContain('# thresholds the team agreed on');
      expect(config).toContain('max_direct_relations: 10');
      expect(config).toContain('model: sonnet');
      const arch = read(dir, '.yggdrasil/yg-architecture.yaml');
      expect(arch).not.toContain('sizeExempt');
      expect(arch).toContain('# the app graph');
      // The writer may re-space a flow list; the value is what must survive.
      expect(arch).toMatch(/parents: \[ ?module ?\]/);
      const node = read(dir, '.yggdrasil/model/app/schema/yg-node.yaml');
      expect(node).not.toContain('sizeExempt');
      expect(node).not.toContain('failure');
      expect(node).toContain('# the one model file');
      expect(node).toContain('target: app/other');
      const rule = read(dir, '.yggdrasil/aspects/no-todo/yg-aspect.yaml');
      expect(rule).not.toMatch(/^(id|stability|language):/m);
      expect(rule).toContain('name: NoTodo');

      const checked = run(['check'], dir);
      expect(checked.all).not.toMatch(/unknown key|aspect-unknown-key|config-quality-unknown-key|config-tier-unknown-key|architecture-invalid|yaml-invalid/);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  it('2: a key nobody retired stays for the owner to correct, and check still names it', () => {
    const dir = build('typo', {
      '.yggdrasil/model/app/other/yg-node.yaml': 'name: Other\ntype: entity\ndescription: Another model.\nrelation: []\nmapping:\n  - src/other.ts\n',
    });
    try {
      const upgraded = run(['init', '--upgrade'], dir);
      expect(upgraded.status).toBe(0);
      expect(upgraded.all).not.toContain("'relation'");
      expect(read(dir, '.yggdrasil/model/app/other/yg-node.yaml')).toContain('relation: []');
      const checked = run(['check'], dir);
      expect(checked.status).toBe(1);
      expect(checked.all).toContain("'relation' (did you mean 'relations'?)");
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  it('3: a rule installed from a package is never edited', () => {
    const packaged = '.yggdrasil/aspects/packages/acme/law/demo/rule/yg-aspect.yaml';
    const body = 'name: Packaged\ndescription: From a package.\nreviewer:\n  type: deterministic\nstability: protocol\n';
    const dir = build('package', { [packaged]: body });
    try {
      const upgraded = run(['init', '--upgrade'], dir);
      expect(upgraded.all).not.toContain('packages/acme');
      expect(read(dir, packaged)).toBe(body);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  it('4: a second upgrade removes nothing', () => {
    const dir = build('twice');
    try {
      expect(run(['init', '--upgrade'], dir).status).toBe(0);
      const before = read(dir, '.yggdrasil/model/app/schema/yg-node.yaml');
      const again = run(['init', '--upgrade'], dir);
      expect(again.status).toBe(0);
      expect(again.all).not.toContain('Removed retired key');
      expect(read(dir, '.yggdrasil/model/app/schema/yg-node.yaml')).toBe(before);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });
});
