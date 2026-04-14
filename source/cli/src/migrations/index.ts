import type { Migration } from '../core/migrator.js';
import { migrateTo4 } from './to-4.0.0.js';

export const MIGRATIONS: Migration[] = [
  {
    to: '4.0.0',
    description: 'Enforcement-only model: remove node/flow artifacts, flatten aspects and mapping, split architecture, reset drift state',
    run: migrateTo4,
  },
];
