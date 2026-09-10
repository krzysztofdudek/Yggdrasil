import path from 'node:path';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { Migration, MigrationResult } from '../core/migrator.js';
import { LOCK_LOGS_FILE_NAME } from '../model/lock.js';
import { toPosixPath } from '../utils/posix.js';

type StepResult = { actions: string[]; warnings: string[] };
type MigrationStep = (yggRoot: string) => Promise<StepResult>;

/**
 * Strip the retired `ports` section from every node entry in the committed
 * logs lock — reading and rewriting the RAW JSON directly, never through
 * readLock/writeLock. Those now validate `NODE_KEYS` as exactly
 * `{'source', 'log'}` and would refuse a lingering `ports` key with
 * `unexpected key "ports"` before this step ever got a chance to remove it.
 * Running before that validator ever sees the file is what lets a lock
 * written before 6.0.0 pass an ordinary `yg check` afterward.
 *
 * Unconditional: `ports` is dropped whatever shape it is (object, array,
 * scalar) — a garbled leftover from an old build must not block the one
 * migration that clears it. Idempotent: a no-op when the file is absent,
 * unparseable (the ordinary lock-invalid path diagnoses that case, not this
 * one), or carries no `ports` key anywhere.
 */
async function stripLockPorts(yggRoot: string): Promise<StepResult> {
  const logsPath = path.join(yggRoot, LOCK_LOGS_FILE_NAME);
  let raw: string;
  try {
    raw = await readFile(logsPath, 'utf-8');
  } catch {
    return { actions: [], warnings: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { actions: [], warnings: [] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { actions: [], warnings: [] };
  }
  const obj = parsed as Record<string, unknown>;
  const nodes = obj.nodes;
  if (typeof nodes !== 'object' || nodes === null || Array.isArray(nodes)) {
    return { actions: [], warnings: [] };
  }

  let changed = 0;
  for (const entry of Object.values(nodes as Record<string, unknown>)) {
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry) && 'ports' in entry) {
      delete (entry as Record<string, unknown>).ports;
      changed++;
    }
  }
  if (changed === 0) return { actions: [], warnings: [] };

  await writeFile(logsPath, JSON.stringify(obj), 'utf-8');
  return {
    actions: [
      `removed the retired 'ports' section from ${changed} node ${changed === 1 ? 'entry' : 'entries'} in ${LOCK_LOGS_FILE_NAME}`,
    ],
    warnings: [],
  };
}

/** One port's offending field, found in a node's yg-node.yaml. */
function findOffendingPorts(nodeYamlPath: string, nodePath: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(nodeYamlPath, 'utf-8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const ports = (parsed as Record<string, unknown>).ports;
  if (typeof ports !== 'object' || ports === null || Array.isArray(ports)) return [];

  const out: string[] = [];
  for (const [portName, portDef] of Object.entries(ports as Record<string, unknown>)) {
    if (typeof portDef !== 'object' || portDef === null || Array.isArray(portDef)) continue;
    const def = portDef as Record<string, unknown>;
    if (def.version !== undefined) {
      out.push(`${nodePath}: ports.${portName}.version — delete this field from .yggdrasil/model/${nodePath}/yg-node.yaml`);
    }
    if (def.test !== undefined) {
      out.push(`${nodePath}: ports.${portName}.test — delete this field from .yggdrasil/model/${nodePath}/yg-node.yaml`);
    }
  }
  return out;
}

/**
 * A graph that still declares `ports.<name>.version` or `.test` cannot be
 * fixed by this migration — the field is gone, and there is no value to carry
 * forward for the adopter. This only WARNS, naming every offending node and
 * port, so the parser's strict refusal on the next `yg check` (or the very
 * next `loadGraph` this same upgrade command makes, to refresh coverage
 * predictions) is not the first anyone hears of it.
 */
async function warnGraphLevelPortFields(yggRoot: string): Promise<StepResult> {
  const modelDir = path.join(yggRoot, 'model');
  const warnings: string[] = [];
  if (!existsSync(modelDir)) return { actions: [], warnings };

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === 'yg-node.yaml') {
        const nodePath = toPosixPath(path.relative(modelDir, dir)) || '.';
        warnings.push(...findOffendingPorts(full, nodePath));
      }
    }
  };
  walk(modelDir);
  return { actions: [], warnings };
}

// Each concern that targets 6.0.0 is a STEP, aggregated below. Keep steps
// idempotent so a re-run is safe.
const STEPS: MigrationStep[] = [stripLockPorts, warnGraphLevelPortFields];

export const migration: Migration = {
  to: '6.0.0',
  description:
    "Remove the retired ports section from the committed lock; warn about any yg-node.yaml still declaring a port's version or test (removed — delete those fields by hand).",
  async run(yggRoot: string): Promise<MigrationResult> {
    const actions: string[] = [];
    const warnings: string[] = [];
    for (const step of STEPS) {
      const r = await step(yggRoot);
      actions.push(...r.actions);
      warnings.push(...r.warnings);
    }
    return { actions, warnings };
  },
};
