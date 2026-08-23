import type { RootsConfig } from '../model/graph.js';

export function isRootsConfig(value: unknown): value is RootsConfig {
  return typeof value === 'object' && value !== null;
}
