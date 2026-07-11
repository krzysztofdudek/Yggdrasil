// Migration to 5.6.0: adds a telemetry block to yg-config.yaml.
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type { Migration, MigrationResult } from '../core/migrator.js';

export const migration: Migration = {
  to: '5.6.0',
  description: 'Add the telemetry block to yg-config.yaml.',
  async run(yggRoot: string): Promise<MigrationResult> {
    const configPath = path.join(yggRoot, 'yg-config.yaml');
    const content = await readFile(configPath, 'utf8');
    if (content.includes('\ntelemetry:')) {
      return { actions: [], warnings: [] };
    }
    await writeFile(configPath, `${content}\ntelemetry:\n  enabled: true\n`);
    return { actions: ['added telemetry block'], warnings: [] };
  },
};
