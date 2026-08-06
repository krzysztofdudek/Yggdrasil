import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runStructureAspect } from '../../../src/structure/runner.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';

describe('runStructureAspect — eager AST enrichment on own ctx.files', () => {
  let projectRoot: string;
  let cbCounter = 0;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-structure-eager-ast-'));
    mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'export const x = 1;');
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  async function writeAspect(aspectId: string, checkBody: string): Promise<string> {
    cbCounter += 1;
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', aspectId);
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(path.join(aspectDir, 'check.mjs'), `// cb=${cbCounter}\n${checkBody}`);
    return aspectDir;
  }

  it('own ctx.files carry .ast and .language === "typescript"', async () => {
    await writeAspect('eager-ast', `export function check(ctx) {
  const f = ctx.files.find(x => x.path.endsWith('.ts'));
  if (!f) return [{ message: 'no .ts file mapped', file: ctx.files[0]?.path }];
  if (!f.ast || f.language !== 'typescript') {
    return [{ message: 'no eager ast/language on own file', file: f.path }];
  }
  return [];
}`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    const result = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/eager-ast'),
      aspectId: 'eager-ast', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    });
    expect(result.succeeded).toBe(true);
    expect(result.violations).toEqual([]);
  });
});
