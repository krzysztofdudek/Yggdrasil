import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// tests/unit/roots/genericity-lint.test.ts — proves the `local/roots-
// genericity-fence` eslint rule (source/cli/eslint.config.js) actually
// fires, by SPAWNING the eslint CLI rather than importing anything (so this
// file itself creates no graph edge — it imports nothing from src/** or the
// eslint config).
//
// The filename passed to `--stdin-filename` is CONFIG-RELATIVE: eslint
// resolves it against its own cwd, which this spawn pins to source/cli/ (the
// only cwd where eslint.config.js is found). A `source/cli/`-prefixed value
// would double that prefix and make the config's `files: ['src/roots/**']`
// scope match nothing — while every globally-scoped rule (no-unused-vars,
// the recommended sets) would still fire normally, producing a clean-looking
// but silently-scoped-out run. That is the exact failure mode
// eslint.config.js's own top-of-file note records for a previous rule (a
// resolver-based one that quietly stopped enforcing anything), so the third
// assertion below checks the DIRTY run's output actually names
// `local/roots-genericity-fence` — the one check that fails red if this rule
// ever regresses into that same silent no-op.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const ESLINT_BIN = path.join(CLI_ROOT, 'node_modules', '.bin', 'eslint');
const RULE_ID = 'local/roots-genericity-fence';

interface EslintMessage {
  ruleId: string | null;
  messageId?: string;
}
interface EslintResult {
  messages: EslintMessage[];
  errorCount: number;
}

function runEslintOnStdin(source: string): EslintResult[] {
  const r = spawnSync(ESLINT_BIN, ['--stdin', '--stdin-filename', 'src/roots/virtual.ts', '--format', 'json'], {
    cwd: CLI_ROOT,
    input: source,
    encoding: 'utf-8',
  });
  // eslint exits 1 when lint errors were found — that is a normal outcome
  // here, not a spawn failure. A spawn failure (bad binary, crash) instead
  // leaves stdout empty/unparseable, which JSON.parse below surfaces loudly.
  return JSON.parse(r.stdout) as EslintResult[];
}

const CLEAN_SOURCE = `import { hashString } from '../io/hash.js';
import { rootsConfigHash } from './config.js';
import type { RootsConfig } from '../model/graph.js';

export function combine(config: RootsConfig): string {
  return hashString(rootsConfigHash(config));
}
`;

const DIRTY_SOURCE = `import { Parser } from 'web-tree-sitter';

function pickGrammar(extension: string): boolean {
  return extension === '.ts';
}

export function use(): unknown {
  return { Parser, pickGrammar };
}
`;

// F4 probe: a `.wasm` path written as a plain string literal — never
// imported, so only the widened Literal visitor's banned-specifier check
// (not the import-specifier walk) can catch it.
const WASM_STRING_LITERAL_SOURCE = `export const grammarPath = './grammars/tree-sitter-python.wasm';
`;

// F5 probe: `import('web-tree-sitter')` used purely as a TYPE — no
// ImportDeclaration/ImportExpression node exists for it, so only the
// dedicated TSImportType visitor can catch it.
const TS_IMPORT_TYPE_SOURCE = `export type Tree = import('web-tree-sitter').Tree;
`;

describe('roots genericity lint — spawned eslint CLI proof', () => {
  it('clean source (allowlisted imports only, no extension literal) passes with zero errors', () => {
    const [result] = runEslintOnStdin(CLEAN_SOURCE);
    expect(result.errorCount).toBe(0);
    expect(result.messages.filter((m) => m.ruleId === RULE_ID)).toHaveLength(0);
  });

  it('dirty source reports BOTH the banned grammar import and the banned extension literal, and the output names the rule itself', () => {
    const [result] = runEslintOnStdin(DIRTY_SOURCE);
    const fenceMessages = result.messages.filter((m) => m.ruleId === RULE_ID);

    // The scope-miss failure mode described above would report ZERO fence
    // messages here (only e.g. no-unused-vars, if anything) — this assertion
    // is what turns that regression into a red test rather than a silent pass.
    expect(fenceMessages.length).toBeGreaterThanOrEqual(2);
    expect(fenceMessages.some((m) => m.messageId === 'bannedGrammarImport')).toBe(true);
    expect(fenceMessages.some((m) => m.messageId === 'extensionLiteral')).toBe(true);

    // Belt-and-suspenders on the exact failure mode this test exists to
    // catch: the rule's own id must be present in the reported output.
    const allRuleIds = result.messages.map((m) => m.ruleId);
    expect(allRuleIds).toContain(RULE_ID);
  });

  it('a .wasm path written as a plain string literal (never imported) is reported', () => {
    const [result] = runEslintOnStdin(WASM_STRING_LITERAL_SOURCE);
    const fenceMessages = result.messages.filter((m) => m.ruleId === RULE_ID);
    expect(fenceMessages.some((m) => m.messageId === 'bannedGrammarImport')).toBe(true);
  });

  it("import('web-tree-sitter') used purely as a type (TSImportType) is reported", () => {
    const [result] = runEslintOnStdin(TS_IMPORT_TYPE_SOURCE);
    const fenceMessages = result.messages.filter((m) => m.ruleId === RULE_ID);
    expect(fenceMessages.some((m) => m.messageId === 'bannedGrammarImport')).toBe(true);
  });
});
