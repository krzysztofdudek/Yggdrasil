import type { Migration } from '../core/migrator.js';
import { migrateTo2 } from './to-2.0.0.js';
import { migrateTo3 } from './to-3.0.0.js';
import { migrateToV4 } from './to-4.0.0.js';

export const MIGRATIONS: Migration[] = [
  {
    to: '2.0.0',
    description: 'Rename YAML files to yg-* prefix, restructure config, convert aspects format',
    run: migrateTo2,
  },
  {
    to: '3.0.0',
    description: 'Remove artifacts section from config (now hardcoded in CLI)',
    run: migrateTo3,
  },
  {
    to: '4.0.0',
    description: 'Convert bare-string anchor arrays to typed anchor objects',
    run: migrateToV4,
  },
];
