import { parseConfig } from '../config-parser.js';

export function read(path) {
  return parseConfig(path, { skipSecretsOverlay: true });
}
