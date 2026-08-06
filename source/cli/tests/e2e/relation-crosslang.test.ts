import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// End-to-end: the symbol table is partitioned BY LANGUAGE. A bare type name
// declared in one language must never satisfy a same-name symbol use in
// another. The historical FP: Ruby `class X < Connection` resolving onto a
// C++ `class Connection` (both keyed as bare "Connection" in one shared
// table). After A1, the cross-language case is SILENT (no violation); the
// paired same-language Ruby->Ruby require_relative edge still fires.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, status: result.status, all: stdout + stderr };
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

function baseRepo(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `yg-rel-xlang-${label}-`));
  writeFile(
    root,
    '.yggdrasil/yg-architecture.yaml',
    [
      'node_types:',
      '  component:',
      "    description: 'A source component mapped under src/.'",
      '    log_required: false',
      '    when:',
      '      path: "src/**"',
      '    relations:',
      '      uses: [component]',
      '',
    ].join('\n'),
  );
  writeFile(
    root,
    '.yggdrasil/yg-config.yaml',
    [
      'version: "5.2.0"',
      '',
      'quality:',
      '  max_direct_relations: 10',
      '',
      'reviewer:',
      '  default: standard',
      '  tiers:',
      '    standard:',
      '      provider: ollama',
      '      consensus: 1',
      '      config:',
      '        model: "qwen2.5-coder:0.5b"',
      '        endpoint: "http://host.docker.internal:11434"',
      '',
    ].join('\n'),
  );
  return root;
}

// FP fixture: C++ node declares `class Connection`; Ruby node subclasses
// `Connection`. NO relation declared. Must NOT flag (different languages).
function buildCrossLangRepo(): string {
  const root = baseRepo('xlang');
  writeFile(
    root,
    '.yggdrasil/model/cppnet/yg-node.yaml',
    'name: CppNet\ndescription: C++ networking component.\ntype: component\nmapping:\n  - src/cppnet\n',
  );
  writeFile(
    root,
    '.yggdrasil/model/rubyapp/yg-node.yaml',
    'name: RubyApp\ndescription: Ruby app component.\ntype: component\nmapping:\n  - src/rubyapp\n',
  );
  writeFile(
    root,
    'src/cppnet/connection.cpp',
    ['class Connection {', 'public:', '  void open();', '};', ''].join('\n'),
  );
  // Ruby file uses the bare constant `Connection` as a superclass — a symbol hint.
  writeFile(
    root,
    'src/rubyapp/session.rb',
    ['class Session < Connection', '  def start; end', 'end', ''].join('\n'),
  );
  return root;
}

// Positive control: two Ruby nodes; rubyapp/session.rb require_relatives
// rubylib/connection.rb across the node boundary with NO declared relation.
// Same-language path edge → MUST flag (partition did not blanket-silence).
function buildSameLangRepo(): string {
  const root = baseRepo('samelang');
  writeFile(
    root,
    '.yggdrasil/model/rubylib/yg-node.yaml',
    'name: RubyLib\ndescription: Ruby library component.\ntype: component\nmapping:\n  - src/rubylib\n',
  );
  writeFile(
    root,
    '.yggdrasil/model/rubyapp/yg-node.yaml',
    'name: RubyApp\ndescription: Ruby app component.\ntype: component\nmapping:\n  - src/rubyapp\n',
  );
  writeFile(root, 'src/rubylib/connection.rb', ['class Connection', '  def open; end', 'end', ''].join('\n'));
  writeFile(
    root,
    'src/rubyapp/session.rb',
    ["require_relative '../rubylib/connection'", 'class Session < Connection', '  def start; end', 'end', ''].join('\n'),
  );
  return root;
}

describe.skipIf(!distExists)('CLI E2E — symbol table is language-partitioned', () => {
  it('does NOT flag a Ruby constant use against a same-name C++ class (cross-language FP closed)', () => {
    const repo = buildCrossLangRepo();
    try {
      const res = run(['check', '--approve'], repo);
      expect(res.status, res.all).toBe(0);
      expect(res.all).not.toContain('relation-undeclared-dependency');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('STILL flags a same-language Ruby->Ruby require_relative across nodes (no over-silencing)', () => {
    const repo = buildSameLangRepo();
    try {
      const res = run(['check', '--approve'], repo);
      expect(res.status, res.all).toBe(1);
      expect(res.all).toContain('relation-undeclared-dependency');
      expect(res.all).toContain('src/rubyapp/session.rb');
      expect(res.all).toContain('rubylib');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
