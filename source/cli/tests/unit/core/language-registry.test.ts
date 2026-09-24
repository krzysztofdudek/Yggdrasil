import { describe, it, expect } from 'vitest';
import { LANGUAGES, EXTENSION_TO_LANGUAGE, getLanguageForExtension, getGrammarForExtension, getLanguageDisplayName, grammarExtensionForPath } from '../../../src/utils/language-registry.js';

describe('language registry', () => {
  it('lists Tier 0 (ts/tsx/js) + Tier 1 + JSON', () => {
    expect(Object.keys(LANGUAGES).sort()).toEqual([
      'c', 'cpp', 'csharp', 'go', 'java', 'javascript', 'json', 'kotlin',
      'php', 'python', 'ruby', 'rust', 'toml', 'tsx', 'typescript', 'yaml',
    ]);
  });

  it('each entry id matches its key and has a wasmFile + a complete grammar pin', () => {
    for (const [key, def] of Object.entries(LANGUAGES)) {
      expect(def.id).toBe(key);
      expect(def.wasmFile).toMatch(/\.wasm$/);
      const pin = def.grammar;
      expect(pin.repo).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
      expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(pin.version.length).toBeGreaterThan(0);
      expect(pin.cli.length).toBeGreaterThan(0);
      expect([13, 14, 15]).toContain(pin.abi);
      expect(pin.wasmSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.nodeTypesSha256).toMatch(/^[0-9a-f]{64}$/);
      // A grammar this repository builds names the exact CLI, never a range.
      if (pin.source.kind === 'source') expect(pin.cli).toMatch(/^\d+\.\d+\.\d+$/);
      if (pin.source.kind === 'github-release') expect(pin.source.wasmUrl).toMatch(/^https:\/\/github\.com\/.+\/releases\/download\//);
    }
  });

  it('no two languages ship the same wasm file name', () => {
    const names = Object.values(LANGUAGES).map((d) => d.wasmFile);
    expect(new Set(names).size).toBe(names.length);
  });

  it('extension map is consistent with each LANGUAGES entry', () => {
    for (const [ext, lang] of Object.entries(EXTENSION_TO_LANGUAGE)) {
      expect(LANGUAGES[lang].extensions).toContain(ext);
    }
  });

  it('no extension appears in two language entries', () => {
    const seen = new Set<string>();
    for (const def of Object.values(LANGUAGES)) {
      for (const ext of def.extensions) {
        expect(seen.has(ext)).toBe(false);
        seen.add(ext);
      }
    }
  });

  it('.ts → typescript', () => {
    expect(getLanguageForExtension('.ts')).toBe('typescript');
  });

  it('.tsx → tsx', () => {
    expect(getLanguageForExtension('.tsx')).toBe('tsx');
  });

  it('unknown returns null', () => {
    expect(getLanguageForExtension('.zig')).toBeNull();
  });

  it('user overrides win', () => {
    expect(getLanguageForExtension('.h', { '.h': 'cpp' })).toBe('cpp');
  });

  it('each language has commentTypes', () => {
    expect(LANGUAGES.typescript.commentTypes).toContain('comment');
    expect(LANGUAGES.tsx.commentTypes).toContain('comment');
    expect(LANGUAGES.javascript.commentTypes).toContain('comment');
  });

  it('.jsx maps to javascript (not tsx)', () => {
    expect(getLanguageForExtension('.jsx')).toBe('javascript');
  });
});

describe('getGrammarForExtension', () => {
  it('maps .ts to the typescript grammar', () => {
    expect(getGrammarForExtension('.ts')).toEqual({ wasmFile: 'tree-sitter-typescript.wasm' });
  });
  it('maps .tsx to the tsx wasm', () => {
    expect(getGrammarForExtension('.tsx')).toEqual({ wasmFile: 'tree-sitter-tsx.wasm' });
  });
  it('maps .js/.mjs/.cjs/.jsx to the javascript grammar', () => {
    for (const ext of ['.js', '.mjs', '.cjs', '.jsx']) {
      expect(getGrammarForExtension(ext)).toEqual({ wasmFile: 'tree-sitter-javascript.wasm' });
    }
  });
  it('is case-insensitive (.TS resolves like .ts)', () => {
    expect(getGrammarForExtension('.TS')?.wasmFile).toBe('tree-sitter-typescript.wasm');
  });
  it('maps .py to the python grammar', () => {
    expect(getGrammarForExtension('.py')).toEqual({ wasmFile: 'tree-sitter-python.wasm' });
  });
  it('maps .rs to the rust grammar', () => {
    expect(getGrammarForExtension('.rs')).toEqual({ wasmFile: 'tree-sitter-rust.wasm' });
  });
  it('returns null for a still-unregistered extension', () => {
    expect(getGrammarForExtension('.swift')).toBeNull();
  });

  describe('getLanguageDisplayName', () => {
    it('uses explicit display names for ids whose casing is not a simple capitalization', () => {
      expect(getLanguageDisplayName('typescript')).toBe('TypeScript');
      expect(getLanguageDisplayName('tsx')).toBe('TSX');
      expect(getLanguageDisplayName('javascript')).toBe('JavaScript');
      expect(getLanguageDisplayName('csharp')).toBe('C#');
      expect(getLanguageDisplayName('cpp')).toBe('C++');
      expect(getLanguageDisplayName('php')).toBe('PHP');
      expect(getLanguageDisplayName('json')).toBe('JSON');
      expect(getLanguageDisplayName('yaml')).toBe('YAML');
      expect(getLanguageDisplayName('toml')).toBe('TOML');
    });

    it('capitalizes the first letter for every other registered id', () => {
      expect(getLanguageDisplayName('python')).toBe('Python');
      expect(getLanguageDisplayName('go')).toBe('Go');
      expect(getLanguageDisplayName('rust')).toBe('Rust');
      expect(getLanguageDisplayName('java')).toBe('Java');
      expect(getLanguageDisplayName('c')).toBe('C');
      expect(getLanguageDisplayName('ruby')).toBe('Ruby');
      expect(getLanguageDisplayName('kotlin')).toBe('Kotlin');
    });

    it('is total — an unknown id capitalizes, and the empty string is returned as-is', () => {
      expect(getLanguageDisplayName('haskell')).toBe('Haskell');
      expect(getLanguageDisplayName('')).toBe('');
    });
  });
});

describe('Ruby files beyond .rb', () => {
  it('maps .rake, .gemspec and .ru to ruby', () => {
    for (const ext of ['.rake', '.gemspec', '.ru']) expect(getLanguageForExtension(ext)).toBe('ruby');
  });

  it('gives the extension-less Ruby files the Ruby grammar extension, and leaves other paths alone', () => {
    for (const p of ['Rakefile', 'Gemfile', 'app/Guardfile', 'deploy/Capfile', 'Brewfile']) {
      expect(grammarExtensionForPath(p)).toBe('.rb');
    }
    expect(grammarExtensionForPath('lib/tasks/x.rake')).toBe('.rake');
    expect(grammarExtensionForPath('src/a.PY')).toBe('.PY');
    expect(grammarExtensionForPath('Makefile')).toBe('');
    expect(grammarExtensionForPath('.gitignore')).toBe('');
    expect(grammarExtensionForPath('docs/Rakefile.md')).toBe('.md');
  });
});
