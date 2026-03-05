import type { Migration } from '../core/migrator.js';
import { migrateTo2 } from './to-2.0.0.js';

export const MIGRATIONS: Migration[] = [
  {
    to: '2.0.0',
    description: 'Rename YAML files to yg-* prefix, restructure config, convert aspects format',
    run: migrateTo2,
  },
];
