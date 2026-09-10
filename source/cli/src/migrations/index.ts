import type { Migration } from '../core/migrator.js';
import { migration as to_5_1_0 } from './to-5.1.0.js';
import { migration as to_6_0_0 } from './to-6.0.0.js';

export const MIGRATIONS: Migration[] = [to_5_1_0, to_6_0_0];
