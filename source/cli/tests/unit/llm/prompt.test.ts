// Goldens pin buildPairPrompt's exact bytes. Per-node output MUST stay byte-identical
// to the legacy builder for equivalent inputs — any scaffold change that alters output
// is a breaking change. To regenerate after an INTENTIONAL scaffold change:
//   console.log(buildPairPrompt(inputN)) and overwrite the corresponding fixture file.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPairPrompt, assembledPromptChars } from '../../../src/llm/prompt.js';
import type { PairPromptInput } from '../../../src/llm/prompt.js';

const FIXTURES = join(import.meta.dirname, '../../fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

const input1: PairPromptInput = {
  aspect: {
    id: 'test-aspect',
    description: 'A "quoted" description with <xml> & ampersand',
    content: '# Rules\n\nMust do X.\n\n- Rule 1\n- Rule 2',
  },
  nodePath: 'billing/order-handler',
  files: [
    { path: 'src/billing/handler.ts', content: 'export function handleOrder(x: string) {\n  return x;\n}' },
    { path: 'src/billing/utils.ts', content: 'export function util() {}' },
  ],
  references: [
    { path: 'docs/codes.md', description: 'Error codes catalog', content: 'ERR001: bad request\nERR002: not found' },
    { path: 'docs/guide.md', content: 'See guide for details' },
  ],
  scope: undefined,
};

const input2: PairPromptInput = {
  aspect: { id: 'simple', description: '', content: 'Simple rule' },
  nodePath: 'core/loader',
  files: [{ path: 'src/loader.ts', content: 'const x = 1;' }],
  references: [],
  scope: undefined,
};

const inputPerFile: PairPromptInput = {
  aspect: {
    id: 'test-aspect',
    description: 'A "quoted" description with <xml> & ampersand',
    content: '# Rules\n\nMust do X.\n\n- Rule 1\n- Rule 2',
  },
  nodePath: 'billing/order-handler',
  files: [
    { path: 'src/billing/handler.ts', content: 'export function handleOrder(x: string) {\n  return x;\n}' },
  ],
  references: [
    { path: 'docs/codes.md', description: 'Error codes catalog', content: 'ERR001: bad request\nERR002: not found' },
  ],
  scope: { per: 'file' },
};

// A file enforced by its architecture type alone — no owning component, so
// nodePath is omitted entirely (never rendered as an
// empty '' component under a header announcing one).
const inputNodeless: PairPromptInput = {
  aspect: { id: 'a', description: 'd', content: 'rule body' },
  references: [],
  files: [{ path: 'src/leaf/a.ts', content: 'x' }],
  scope: { per: 'file' },
};

// The same nodeless subject, but with a reference, a companion, or both
// resolved into the prompt — the shape the bare `inputNodeless` above (empty
// references, no companions) cannot exercise. The single-file framing
// sentence must read as true in every one of these four combinations: with
// nothing else in the prompt, it is the whole context; with a reference
// and/or companion present, THEY are the whole context, rendered with full
// bodies right below the sentence.
const nodelessReference = { path: 'docs/guide.md', description: 'The canonical helper this rule cites.', content: 'GUIDE BODY' };
const nodelessCompanion = { path: 'src/helper/h.ts', content: 'COMPANION BODY', label: 'helper' };
const inputNodelessWithReferences: PairPromptInput = { ...inputNodeless, references: [nodelessReference] };
const inputNodelessWithCompanions: PairPromptInput = { ...inputNodeless, companions: [nodelessCompanion] };
const inputNodelessWithBoth: PairPromptInput = {
  ...inputNodeless,
  references: [nodelessReference],
  companions: [nodelessCompanion],
};

describe('buildPairPrompt — per-node golden', () => {
  it('golden 1: byte-identical to fixture (references + description with special chars)', () => {
    const expected = loadFixture('prompt-per-node-golden-1.txt');
    const actual = buildPairPrompt(input1);
    expect(actual).toBe(expected);
  });

  it('golden 2: byte-identical to fixture (minimal, no references, empty description)', () => {
    const expected = loadFixture('prompt-per-node-golden-2.txt');
    const actual = buildPairPrompt(input2);
    expect(actual).toBe(expected);
  });
});

describe('buildPairPrompt — per-file golden', () => {
  it('per-file golden: byte-identical to fixture', () => {
    const expected = loadFixture('prompt-per-file-golden.txt');
    const actual = buildPairPrompt(inputPerFile);
    expect(actual).toBe(expected);
  });

  it('per-file contains the exact framing sentence', () => {
    const prompt = buildPairPrompt(inputPerFile);
    expect(prompt).toContain(
      'You are reviewing ONE file of a larger component. Other files of the component are not shown; the absence of sibling context is NOT a violation by itself. Judge only what this file must satisfy on its own.'
    );
  });

  it('per-file contains exactly one file (the single subject)', () => {
    const prompt = buildPairPrompt(inputPerFile);
    const matches = [...prompt.matchAll(/<file path=/g)];
    expect(matches).toHaveLength(1);
    expect(prompt).toContain('src/billing/handler.ts');
  });

  it('per-node does NOT contain the per-file framing sentence', () => {
    const prompt = buildPairPrompt(input1);
    expect(prompt).not.toContain('You are reviewing ONE file of a larger component.');
  });
});

describe('buildPairPrompt — nodeless (a file with no component)', () => {
  it('says nothing about a component: no <node> element, no "node (component)" framing, no "larger component" framing paragraph', () => {
    const p = buildPairPrompt(inputNodeless);
    expect(p).not.toContain('<node');
    expect(p).not.toContain('node (component)');
    // The per-file framing paragraph must not claim a component exists either —
    // a nodeless unit has none, so "of a larger component" would be false here.
    expect(p).not.toContain('of a larger component');
    expect(p).not.toContain('You are reviewing ONE file of a larger component.');
    expect(p).toContain('src/leaf/a.ts');
    expect(p).toBe(loadFixture('prompt-nodeless-per-file-golden.txt'));
  });

  it('leaves the component-owned prompts byte-identical (golden pins unchanged)', () => {
    expect(buildPairPrompt(input1)).toBe(loadFixture('prompt-per-node-golden-1.txt'));
    expect(buildPairPrompt(input2)).toBe(loadFixture('prompt-per-node-golden-2.txt'));
    expect(buildPairPrompt(inputPerFile)).toBe(loadFixture('prompt-per-file-golden.txt'));
  });

  it('omits the component element entirely — no blank line where it was', () => {
    const p = buildPairPrompt(inputNodeless);
    // Exactly one blank line between </task> and <aspect — no gap left by a
    // missing <node> block.
    expect(p).toContain('</task>\n\n<aspect');
  });

  it('carries an honest single-file framing sentence in place of the false componented one', () => {
    const p = buildPairPrompt(inputNodeless);
    // The operative instruction survives (absence of context is not itself a
    // violation) but nothing here claims a component exists.
    expect(p).toContain(
      'You are reviewing this file on its own. It has no owning component, so there are no component siblings to show; any references or companions this prompt includes are the entire extent of that context, and having none beyond the file itself is NOT a violation by itself. Judge only what this file must satisfy on its own.'
    );
  });

  it('a component element renders from the path alone — nothing else is needed to build it', () => {
    // The element carries only the path now, so a caller supplying a path and
    // nothing more produces a complete element rather than one with a hole in
    // it. Must not throw or render "undefined".
    const p = buildPairPrompt({ ...inputNodeless, nodePath: 'n' });
    expect(p).not.toContain('undefined');
    expect(p).toContain('<node path="n" />');
  });

  // The framing sentence must stay true across all four shapes a nodeless
  // prompt can take: references and companions each independently present or
  // absent. A prior wording ("No other files are shown") was true only for
  // the bare case below and became false the moment either block rendered —
  // this pins all four so that regression cannot land unnoticed again.
  describe('the framing sentence holds across references x companions', () => {
    const OLD_FALSE_CLAIM = 'No other files are shown';
    const NEW_SENTENCE =
      'You are reviewing this file on its own. It has no owning component, so there are no component siblings to show; any references or companions this prompt includes are the entire extent of that context, and having none beyond the file itself is NOT a violation by itself. Judge only what this file must satisfy on its own.';

    it('bare: no references, no companions — byte-identical to the bare golden', () => {
      const p = buildPairPrompt(inputNodeless);
      expect(p).toContain(NEW_SENTENCE);
      expect(p).not.toContain(OLD_FALSE_CLAIM);
      expect(p).not.toContain('<references>');
      expect(p).not.toContain('<companions>');
      expect(p).toBe(loadFixture('prompt-nodeless-per-file-golden.txt'));
    });

    it('references present, no companions — the reference renders with its full body, not disclaimed away', () => {
      const p = buildPairPrompt(inputNodelessWithReferences);
      expect(p).toContain(NEW_SENTENCE);
      expect(p).not.toContain(OLD_FALSE_CLAIM);
      expect(p).toContain('<reference path="docs/guide.md" description="The canonical helper this rule cites.">\nGUIDE BODY');
      expect(p).not.toContain('<companions>');
    });

    it('companions present, no references — the companion renders with its full body, not disclaimed away', () => {
      const p = buildPairPrompt(inputNodelessWithCompanions);
      expect(p).toContain(NEW_SENTENCE);
      expect(p).not.toContain(OLD_FALSE_CLAIM);
      expect(p).toContain('<companion path="src/helper/h.ts" label="helper">\nCOMPANION BODY');
      expect(p).not.toContain('<references>');
    });

    it('references AND companions both present — byte-identical to the with-context golden', () => {
      const p = buildPairPrompt(inputNodelessWithBoth);
      expect(p).toContain(NEW_SENTENCE);
      expect(p).not.toContain(OLD_FALSE_CLAIM);
      expect(p).toContain('<reference path="docs/guide.md" description="The canonical helper this rule cites.">\nGUIDE BODY');
      expect(p).toContain('<companion path="src/helper/h.ts" label="helper">\nCOMPANION BODY');
      expect(p).toBe(loadFixture('prompt-nodeless-per-file-with-context-golden.txt'));
    });
  });
});

describe('assembledPromptChars', () => {
  it('equals buildPairPrompt(...).length — single source of truth', () => {
    expect(assembledPromptChars(input1)).toBe(buildPairPrompt(input1).length);
    expect(assembledPromptChars(input2)).toBe(buildPairPrompt(input2).length);
    expect(assembledPromptChars(inputPerFile)).toBe(buildPairPrompt(inputPerFile).length);
  });

  it('returns a positive integer', () => {
    const n = assembledPromptChars(input1);
    expect(n).toBeGreaterThan(0);
    expect(Number.isInteger(n)).toBe(true);
  });
});

describe('buildPairPrompt — companions block', () => {
  const BASE = {
    aspect: { id: 'a', description: 'd', content: 'RULE' },
    references: [], nodePath: 'n', scope: undefined,
    files: [{ path: 'src/x.ts', content: 'X' }],
  };

  it('omitting companions is byte-identical to passing []', () => {
    expect(buildPairPrompt({ ...BASE })).toBe(buildPairPrompt({ ...BASE, companions: [] }));
  });

  it('renders a distinct <companions> block with path-sorted entries', () => {
    const out = buildPairPrompt({ ...BASE, companions: [
      { path: 'b/two.ts', content: 'TWO', label: 'pair two' },
      { path: 'a/one.ts', content: 'ONE' },
    ]});
    expect(out).toContain('<companions>');
    expect(out.indexOf('a/one.ts')).toBeLessThan(out.indexOf('b/two.ts')); // sorted
    expect(out).toContain('pair two');
  });

  it('companions block appears before the <source-files> block', () => {
    const out = buildPairPrompt({ ...BASE, companions: [
      { path: 'z/file.ts', content: 'Z' },
    ]});
    expect(out).toContain('<companions>');
    // Use the standalone block tag (prefixed with newline) to avoid matching the
    // "<source-files>" reference that appears in the suppress instruction text.
    expect(out.indexOf('<companions>')).toBeLessThan(out.lastIndexOf('<source-files>'));
  });

  it('companions uses XML escaping for path, label, and content', () => {
    const out = buildPairPrompt({ ...BASE, companions: [
      { path: 'src/<evil>.ts', content: 'a & b', label: '"quoted"' },
    ]});
    expect(out).not.toContain('<evil>');
    expect(out).toContain('&lt;evil&gt;');
    expect(out).toContain('&amp; b');
    expect(out).toContain('&quot;quoted&quot;');
  });
});

describe('assembledPromptChars — label-free gate (D6)', () => {
  const BASE = {
    aspect: { id: 'a', description: 'd', content: 'RULE' },
    references: [], nodePath: 'n', scope: undefined,
    files: [{ path: 'src/x.ts', content: 'X' }],
  };

  it('with no companions, equals buildPairPrompt length', () => {
    expect(assembledPromptChars(BASE)).toBe(buildPairPrompt(BASE).length);
  });

  it('with companions without labels, equals buildPairPrompt length', () => {
    const input = { ...BASE, companions: [{ path: 'a.ts', content: 'A' }] };
    expect(assembledPromptChars(input)).toBe(buildPairPrompt(input).length);
  });

  it('with companions WITH labels, is LESS than buildPairPrompt length (labels stripped)', () => {
    const input = { ...BASE, companions: [{ path: 'a.ts', content: 'A', label: 'my label' }] };
    expect(assembledPromptChars(input)).toBeLessThan(buildPairPrompt(input).length);
  });
});

describe('buildPairPrompt — suppressed-ranges block', () => {
  const BASE: PairPromptInput = {
    aspect: { id: 'a', description: 'd', content: 'RULE' },
    references: [], nodePath: 'n', scope: undefined,
    files: [{ path: 'src/x.ts', content: 'X' }],
  };

  it('omitting suppressedRanges is byte-identical to passing an empty byFile', () => {
    expect(buildPairPrompt({ ...BASE })).toBe(buildPairPrompt({ ...BASE, suppressedRanges: { byFile: [] } }));
  });

  // NOTE: the instruction prose itself mentions the literal "<suppressed-ranges>"
  // (telling the reviewer where to look), so the BLOCK's presence is keyed off the
  // closing tag "</suppressed-ranges>", which appears only in the rendered block.
  it('an empty byFile renders no <suppressed-ranges> block (byte-identical to omitting)', () => {
    const out = buildPairPrompt({ ...BASE, suppressedRanges: { byFile: [] } });
    expect(out).not.toContain('</suppressed-ranges>');
  });

  it('a file whose ranges array is empty renders no block', () => {
    const out = buildPairPrompt({ ...BASE, suppressedRanges: { byFile: [{ path: 'src/x.ts', ranges: [] }] } });
    expect(out).not.toContain('</suppressed-ranges>');
  });

  it('renders a <suppressed-ranges> block naming the file and exact line spans', () => {
    const out = buildPairPrompt({ ...BASE, suppressedRanges: { byFile: [
      { path: 'src/x.ts', ranges: [{ startLine: 10, endLine: 10 }, { startLine: 20, endLine: 25 }] },
    ] } });
    expect(out).toContain('</suppressed-ranges>');
    expect(out).toContain('<file path="src/x.ts">');
    expect(out).toContain('<range start-line="10" end-line="10" />');
    expect(out).toContain('<range start-line="20" end-line="25" />');
  });

  it('the honor-exact-lines instruction is present and the self-interpretation text is GONE', () => {
    const out = buildPairPrompt({ ...BASE, suppressedRanges: { byFile: [
      { path: 'src/x.ts', ranges: [{ startLine: 1, endLine: 1 }] },
    ] } });
    expect(out).toContain('Honor exactly these line ranges');
    // The retired self-interpretation phrasings must NOT survive the swap.
    expect(out).not.toContain('applies to the entire file');
    expect(out).not.toContain('surrounding code\n(function, class, or block where it appears)');
    expect(out).not.toContain('treat the suppressed code as satisfied');
  });

  it('the swapped instruction still references <source-files> (token-dependent tests rely on it)', () => {
    const out = buildPairPrompt({ ...BASE });
    expect(out).toContain('<source-files>');
  });

  it('XML-escapes the file path attribute in the block', () => {
    const out = buildPairPrompt({ ...BASE, suppressedRanges: { byFile: [
      { path: 'src/<evil>&"x".ts', ranges: [{ startLine: 3, endLine: 4 }] },
    ] } });
    expect(out).toContain('<file path="src/&lt;evil&gt;&amp;&quot;x&quot;.ts">');
    expect(out).not.toContain('<file path="src/<evil>');
  });

  it('the block sits before the <source-files> block', () => {
    const out = buildPairPrompt({ ...BASE, suppressedRanges: { byFile: [
      { path: 'src/x.ts', ranges: [{ startLine: 1, endLine: 1 }] },
    ] } });
    // lastIndexOf on both: the prose preamble mentions each tag once before the
    // real blocks, so the last occurrence is the rendered block.
    expect(out.lastIndexOf('<suppressed-ranges>')).toBeLessThan(out.lastIndexOf('<source-files>'));
  });

  it('assembledPromptChars includes the block (strictly greater than without ranges, equals buildPairPrompt length)', () => {
    const withRanges: PairPromptInput = { ...BASE, suppressedRanges: { byFile: [
      { path: 'src/x.ts', ranges: [{ startLine: 1, endLine: 5 }] },
    ] } };
    expect(assembledPromptChars(withRanges)).toBe(buildPairPrompt(withRanges).length);
    expect(assembledPromptChars(withRanges)).toBeGreaterThan(assembledPromptChars(BASE));
  });
});

describe('buildPairPrompt — XML escaping (adopter-controlled fields)', () => {
  it('escapes < and & and " in file path attribute', () => {
    const prompt = buildPairPrompt({
      ...input2,
      files: [{ path: 'src/<evil>&"file".ts', content: 'x' }],
    });
    expect(prompt).not.toContain('<evil>');
    expect(prompt).toContain('&lt;evil&gt;&amp;&quot;file&quot;');
  });

  it('escapes < and & in file content (text node)', () => {
    const prompt = buildPairPrompt({
      ...input2,
      files: [{ path: 'src/a.ts', content: 'const a = <div> & "b";' }],
    });
    expect(prompt).not.toContain('<div>');
    expect(prompt).toContain('&lt;div&gt;');
    expect(prompt).toContain('&amp;');
  });

  it('carries no component description at all — the <node> element is path-only', () => {
    // A component's `description:` is NOT folded into the verdict hash, so a
    // description edit re-verifies nothing. It therefore must not reach the
    // reviewer either: an input that can move a judgment but cannot invalidate
    // the verdict it moved produces a stale green. Passing one through the
    // structurally-impossible route (an extra property) must still not surface.
    const prompt = buildPairPrompt({
      ...input2,
      ...({ nodeDescription: 'A <handler> with "quotes" & ampersands' } as Record<string, unknown>),
    });
    // The <aspect> element legitimately carries its own description (that one IS
    // hashed), so the assertion is scoped to the <node> element alone.
    expect(prompt).toContain(`<node path="${input2.nodePath}" />`);
    expect(prompt).not.toMatch(/<node[^>]*description=/);
    expect(prompt).not.toContain('handler');
    expect(prompt).not.toContain('ampersands');
  });

  it('inserts aspect content RAW (XML-like content.md is NOT escaped)', () => {
    const xmlishContent = '<rule>Do <b>not</b> call foo() & bar()</rule>';
    const prompt = buildPairPrompt({
      ...input2,
      aspect: { ...input2.aspect, content: xmlishContent },
    });
    // Content must appear verbatim — not escaped
    expect(prompt).toContain(xmlishContent);
    expect(prompt).not.toContain('&lt;rule&gt;');
  });
});
