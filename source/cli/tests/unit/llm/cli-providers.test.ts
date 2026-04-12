import { describe, it, expect } from 'vitest';
import { CodexProvider } from '../../../src/llm/codex.js';
import { GeminiCliProvider } from '../../../src/llm/gemini-cli.js';
import { ClineProvider } from '../../../src/llm/cline.js';
import { OpenCodeProvider } from '../../../src/llm/opencode.js';
import { AiderProvider } from '../../../src/llm/aider.js';

describe('CLI providers', () => {
  const providers = [
    { name: 'codex', cls: CodexProvider, binary: 'codex', stdin: true },
    { name: 'gemini-cli', cls: GeminiCliProvider, binary: 'gemini', stdin: false },
    { name: 'cline', cls: ClineProvider, binary: 'cline', stdin: false },
    { name: 'opencode', cls: OpenCodeProvider, binary: 'opencode', stdin: false },
    { name: 'aider', cls: AiderProvider, binary: 'aider', stdin: false },
  ];

  for (const { name, cls, binary, stdin } of providers) {
    describe(name, () => {
      it('has correct binary name', () => {
        const p = new cls({ model: 'test' });
        expect(p.binary).toBe(binary);
      });

      it(`stdinMode is ${stdin}`, () => {
        const p = new cls({ model: 'test' });
        expect(p.stdinMode).toBe(stdin);
      });

      it('buildArgs returns array with model', () => {
        const p = new cls({ model: 'test-model' });
        const args = p.buildArgs('prompt text');
        expect(args).toBeInstanceOf(Array);
        expect(args.some(a => a.includes('test-model'))).toBe(true);
      });

      it('buildArgs includes prompt for non-stdin providers', () => {
        const p = new cls({ model: 'test' });
        if (!stdin) {
          const args = p.buildArgs('my prompt');
          expect(args.some(a => a === 'my prompt')).toBe(true);
        }
      });
    });
  }
});
