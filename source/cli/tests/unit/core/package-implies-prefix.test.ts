// =============================================================================
// Unit — a package names its own rules relatively, and the loader resolves that.
//
// A package is written without knowing where it will be installed, so a rule
// that bundles another writes `implies: [rule-a]`, never a path. The loader
// prefixes it with the install location. What is pinned here:
//
//   1. relative      → prefixed with the install path
//   2. already-full  → REFUSED, with the reason ("a package cannot know")
//   3. outside       → refused, naming both rules
//   4. another package → refused the same way; packages do not depend on packages
//   5. a cycle       → caught by the EXISTING cycle check, on prefixed ids
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { checkImpliesNoCycles } from '../../../src/core/checks/aspects.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const INSTALL = 'packages/acme/law/demo';

/** A repository with one installed package whose rules are given by `rules`. */
function repoWithPackage(rules: Record<string, string>, declared = Object.keys(rules)): string {
  const root = mkdtempSync(join(tmpdir(), 'yg-implies-'));
  tempDirs.push(root);
  const ygg = join(root, '.yggdrasil');
  mkdirSync(join(ygg, 'model'), { recursive: true });
  writeFileSync(join(ygg, 'yg-config.yaml'), 'version: "6.0.0"\n', 'utf-8');
  writeFileSync(join(ygg, 'yg-architecture.yaml'), 'node_types:\n  app:\n    description: x\n', 'utf-8');

  const pkgRoot = join(ygg, 'aspects', ...INSTALL.split('/'));
  mkdirSync(pkgRoot, { recursive: true });
  writeFileSync(
    join(pkgRoot, 'yg-package.yaml'),
    `schema: yg-package/1
name: demo
version: 0.1.0
requires: { yg: ">=1.0.0" }
aspects:
${declared.map((d) => `  - ${d}`).join('\n')}
`,
    'utf-8',
  );
  for (const [name, yaml] of Object.entries(rules)) {
    const dir = join(pkgRoot, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'yg-aspect.yaml'), yaml, 'utf-8');
    if (!yaml.includes('implies:')) writeFileSync(join(dir, 'content.md'), '# Rule\n', 'utf-8');
  }
  return root;
}

const LEAF = (name: string) => `name: ${name}\nreviewer: { type: llm }\n`;

describe('what a rule inside a package may imply', () => {
  it('a relative name becomes the installed one', async () => {
    const root = repoWithPackage({
      'rule-a': LEAF('RuleA'),
      'rule-c': 'name: RuleC\nimplies:\n  - rule-a\n',
    });
    const graph = await loadGraph(root);
    expect(graph.aspectParseErrors ?? []).toEqual([]);
    const bundle = graph.aspects.find((a) => a.id === `${INSTALL}/rule-c`);
    expect(bundle?.implies).toEqual([`${INSTALL}/rule-a`]);
    // And the ids themselves carry the install path, from the loader's own scan.
    expect(graph.aspects.map((a) => a.id).sort()).toEqual([`${INSTALL}/rule-a`, `${INSTALL}/rule-c`]);
  });

  it('a name already written as a full path is REFUSED', async () => {
    // The explicit decision, pinned in both directions. Tolerating it was the
    // alternative; it was rejected because a hard-coded path binds the package to
    // one install location and breaks the moment a consumer uses --as.
    const root = repoWithPackage({
      'rule-a': LEAF('RuleA'),
      'rule-c': `name: RuleC\nimplies:\n  - ${INSTALL}/rule-a\n`,
    });
    const graph = await loadGraph(root);
    const err = (graph.aspectParseErrors ?? []).find((e) => e.code === 'package-implies-not-relative');
    expect(err).toBeDefined();
    expect(err?.messageData.what).toContain(`${INSTALL}/rule-a`);
    expect(err?.messageData.why).toContain('without knowing where it will be installed');
  });

  it('a name from outside the package is refused, naming BOTH rules', async () => {
    const root = repoWithPackage({
      'rule-a': LEAF('RuleA'),
      'rule-c': 'name: RuleC\nimplies:\n  - some-local-rule\n',
    });
    const graph = await loadGraph(root);
    const err = (graph.aspectParseErrors ?? []).find((e) => e.code === 'package-implies-outside-package');
    expect(err).toBeDefined();
    expect(err?.messageData.what).toContain('rule-c');
    expect(err?.messageData.what).toContain('some-local-rule');
  });

  it("a name from ANOTHER package is refused too — packages do not depend on packages", async () => {
    const root = repoWithPackage({
      'rule-a': LEAF('RuleA'),
      'rule-c': 'name: RuleC\nimplies:\n  - packages/other/law/second/rule-x\n',
    });
    const graph = await loadGraph(root);
    // It fails on the FIRST rule: it is written as a path, which a package may
    // never do — and that alone is what stops one package reaching into another.
    const codes = (graph.aspectParseErrors ?? []).map((e) => e.code);
    expect(codes).toContain('package-implies-not-relative');
  });

  it('a cycle inside a package is caught by the existing check, on the PREFIXED ids', async () => {
    // The point worth pinning: prefixing happens in the loader, so the cycle
    // check runs over real installed names. Were it the other way round, two
    // packages using the same relative names could look like one cycle.
    const root = repoWithPackage({
      'rule-a': 'name: RuleA\nimplies:\n  - rule-c\n',
      'rule-c': 'name: RuleC\nimplies:\n  - rule-a\n',
    });
    const graph = await loadGraph(root);
    expect(graph.aspectParseErrors ?? []).toEqual([]);
    const issues = checkImpliesNoCycles(graph);
    expect(issues.length).toBeGreaterThan(0);
    const text = issues.map((i) => i.messageData.what).join(' ');
    expect(text).toContain(`${INSTALL}/rule-a`);
    expect(text).toContain(`${INSTALL}/rule-c`);
  });
});
