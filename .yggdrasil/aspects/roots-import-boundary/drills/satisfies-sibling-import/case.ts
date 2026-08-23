import type { RootsConfig } from './model.js';
import { rootsConfigHash } from './config.js';

export function describeConfig(config: RootsConfig): string {
  return rootsConfigHash(config);
}
