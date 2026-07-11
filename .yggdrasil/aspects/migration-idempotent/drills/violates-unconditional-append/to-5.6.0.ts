// Migration to 5.6.0: adds a telemetry block to yg-config.yaml.
import path from 'node:path';
import { appendFileSync } from 'node:fs';
import type { Migration, MigrationResult } from '../core/migrator.js';

export const migration: Migration = {
  to: '5.6.0',
  description: 'Add the telemetry block to yg-config.yaml.',
  async run(yggRoot: string): Promise<MigrationResult> {
    const configPath = path.join(yggRoot, 'yg-config.yaml');
    appendFileSync(configPath, '\ntelemetry:\n  enabled: true\n');
    return { actions: ['appended telemetry block'], warnings: [] };
  },
};
