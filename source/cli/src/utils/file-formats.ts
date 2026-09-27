/**
 * source/cli/src/utils/file-formats.ts — every YAML file format the CLI reads,
 * in the order `yg schemas list` and the docs name them.
 *
 * One schema object per format (file-formats-graph.ts, file-formats-config.ts,
 * file-formats-package.ts): the parser of the format takes its accepted keys and
 * checks its value types against it, `yg schemas read <name>` prints its field
 * table, and the docs field tables are generated from it.
 */

import type { FileFormatSchema } from './file-schema.js';
import { ARCHITECTURE_FORMAT, ASPECT_ADAPT_FORMAT, ASPECT_FORMAT, FLOW_FORMAT, NODE_FORMAT } from './file-formats-graph.js';
import { CONFIG_FORMAT, SECRETS_FORMAT } from './file-formats-config.js';
import { MARKETPLACE_FORMAT, PACKAGES_FORMAT, PACKAGE_FORMAT } from './file-formats-package.js';

export const FILE_FORMATS: readonly FileFormatSchema[] = [
  CONFIG_FORMAT,
  SECRETS_FORMAT,
  ARCHITECTURE_FORMAT,
  NODE_FORMAT,
  ASPECT_FORMAT,
  ASPECT_ADAPT_FORMAT,
  FLOW_FORMAT,
  PACKAGE_FORMAT,
  MARKETPLACE_FORMAT,
  PACKAGES_FORMAT,
];

/** The format `yg schemas read <name>` names, or undefined. */
export function fileFormat(name: string): FileFormatSchema | undefined {
  return FILE_FORMATS.find((f) => f.name === name);
}
