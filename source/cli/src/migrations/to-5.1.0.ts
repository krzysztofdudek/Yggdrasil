import path from 'node:path';
import { rm, stat } from 'node:fs/promises';
import type { Migration, MigrationResult } from '../core/migrator.js';
import { splitLock } from './split-lock.js';

type StepResult = { actions: string[]; warnings: string[] };
type MigrationStep = (yggRoot: string) => Promise<StepResult>;

/**
 * Remove the obsolete schemas/ directory. Schema references no longer ship as
 * per-project files — they are embedded in the CLI and served by
 * `yg schemas read <name>`. Idempotent: a no-op when the directory is absent.
 */
async function removeSchemasDirectory(yggRoot: string): Promise<StepResult> {
  const schemasDir = path.join(yggRoot, 'schemas');
  try {
    await stat(schemasDir);
  } catch {
    return { actions: [], warnings: [] };
  }
  await rm(schemasDir, { recursive: true, force: true });
  return {
    actions: ['removed schemas/ — schema references now served by `yg schemas read <name>`'],
    warnings: [],
  };
}

// Each concern that targets 5.1.0 is a STEP. Other agent sessions add their
// 5.1.0 step to this array; the migration aggregates the steps' actions and
// warnings. Keep steps idempotent so a re-run is safe.
const STEPS: MigrationStep[] = [removeSchemasDirectory, splitLock];

export const migration: Migration = {
  to: '5.1.0',
  description: 'Remove the schemas/ directory (now served by `yg schemas`); split the lock into committed reviewer-verdict + log files and a gitignored script-verdict cache.',
  async run(yggRoot: string): Promise<MigrationResult> {
    const actions: string[] = [];
    const warnings: string[] = [];
    for (const step of STEPS) {
      const r = await step(yggRoot);
      actions.push(...r.actions);
      warnings.push(...r.warnings);
    }
    return { actions, warnings };
  },
};
