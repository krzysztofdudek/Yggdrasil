import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as yamlParse } from 'yaml';
import type { DriftState, DriftNodeState } from '../model/types.js';

const DRIFT_STATE_FILE = '.drift-state';

export async function readDriftState(yggRoot: string): Promise<DriftState> {
  try {
    const content = await readFile(path.join(yggRoot, DRIFT_STATE_FILE), 'utf-8');

    // Try JSON first (new format), fall back to YAML (legacy format)
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      raw = yamlParse(content);
    }

    if (!raw || typeof raw !== 'object') return {};

    const state: DriftState = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'object' && value !== null && 'hash' in value) {
        state[key] = value as DriftNodeState;
      }
      // Skip legacy string entries silently
    }
    return state;
  } catch {
    return {};
  }
}

export async function writeDriftState(yggRoot: string, state: DriftState): Promise<void> {
  const content = JSON.stringify(state);
  await writeFile(path.join(yggRoot, DRIFT_STATE_FILE), content, 'utf-8');
}
