// =============================================================================
// Unit — the port contract check, against a real on-disk fixture graph.
//
// The rule it implements is one sentence: a port's contract test may not change
// while its contract version stays put. These cases pin the three states it
// reports, and the two properties of the recording half that make the rule hold
// at all — it adds a baseline where there is none, and it never overwrites one.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, rmSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { LOCK_FORMAT_VERSION } from '../../../src/model/lock.js';
import type { LockFile } from '../../../src/model/lock.js';
import type { CheckIssue } from '../../../src/core/check-contract.js';
import {
  classifyPortContracts,
  recordPortContractBaselines,
  IMPLIED_PORT_VERSION,
} from '../../../src/core/checks/port-contracts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '../../fixtures/port-contract');
const CONTRACT_TEST = path.join('tests', 'contracts', 'charge.test.ts');
const PROVIDER = 'services/payments';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function copyFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-portcontract-unit-'));
  cpSync(FIXTURE, dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

function emptyLock(): LockFile {
  return { version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: {} };
}

async function classify(dir: string, lock: LockFile): Promise<CheckIssue[]> {
  const graph = await loadGraph(dir);
  const issues: CheckIssue[] = [];
  await classifyPortContracts(graph, dir, lock, issues);
  return issues;
}

describe('port contracts — what the check reports', () => {
  it('reports an unrecorded contract, and names the free run as the way to record it', async () => {
    const dir = copyFixture();
    const issues = await classify(dir, emptyLock());
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('port-contract-unrecorded');
    expect(issues[0].nodePath).toBe(PROVIDER);
    expect(issues[0].messageData.next).toContain('yg check --approve --only-deterministic');
  });

  it('says nothing once the baseline matches the file on disk', async () => {
    const dir = copyFixture();
    const lock = emptyLock();
    const graph = await loadGraph(dir);
    expect(await recordPortContractBaselines(graph, dir, lock)).toBe(true);
    expect(await classify(dir, lock)).toEqual([]);
  });

  it('refuses a test that changed at an unchanged version, naming the port, the file and both exits', async () => {
    const dir = copyFixture();
    const lock = emptyLock();
    await recordPortContractBaselines(await loadGraph(dir), dir, lock);
    appendFileSync(path.join(dir, CONTRACT_TEST), '\n// a tightened promise\n');

    const issues = await classify(dir, lock);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('port-contract-changed');
    expect(issues[0].messageData.what).toContain("port 'charge' on services/payments (version 1)");
    expect(issues[0].messageData.what).toContain('tests/contracts/charge.test.ts has changed');
    expect(issues[0].messageData.next).toContain('raise ports.charge.version');
    expect(issues[0].messageData.next).toContain('restore tests/contracts/charge.test.ts');
  });

  it('refuses a port that now names a DIFFERENT file at the same version', async () => {
    const dir = copyFixture();
    const lock = emptyLock();
    await recordPortContractBaselines(await loadGraph(dir), dir, lock);
    const twin = path.join('tests', 'contracts', 'charge-twin.test.ts');
    writeFileSync(path.join(dir, twin), readFileSync(path.join(dir, CONTRACT_TEST), 'utf-8'));
    const yaml = path.join(dir, '.yggdrasil', 'model', 'services', 'payments', 'yg-node.yaml');
    writeFileSync(yaml, readFileSync(yaml, 'utf-8').replace('charge.test.ts', 'charge-twin.test.ts'));

    const issues = await classify(dir, lock);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('port-contract-changed');
    // Identical bytes, different file: the contract is the named test, not its content alone.
    expect(issues[0].messageData.what).toContain('it now names tests/contracts/charge-twin.test.ts');
  });

  it('fails closed on a contract test that cannot be read, and records nothing for it', async () => {
    const dir = copyFixture();
    rmSync(path.join(dir, CONTRACT_TEST));
    const lock = emptyLock();

    const issues = await classify(dir, lock);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('port-test-missing');
    expect(issues[0].messageData.what).toContain('cannot be read: tests/contracts/charge.test.ts');

    expect(await recordPortContractBaselines(await loadGraph(dir), dir, lock)).toBe(false);
    expect(lock.nodes[PROVIDER]?.ports).toBeUndefined();
  });
});

describe('port contracts — what the recording half does', () => {
  it('adds a baseline where there is none, and reports having changed nothing on a second pass', async () => {
    const dir = copyFixture();
    const graph = await loadGraph(dir);
    const lock = emptyLock();
    expect(await recordPortContractBaselines(graph, dir, lock)).toBe(true);
    expect(lock.nodes[PROVIDER].ports!.charge['1'].test).toBe('tests/contracts/charge.test.ts');
    expect(await recordPortContractBaselines(graph, dir, lock)).toBe(false);
  });

  it('NEVER overwrites an existing record — that is the whole rule', async () => {
    const dir = copyFixture();
    const graph = await loadGraph(dir);
    const lock = emptyLock();
    lock.nodes[PROVIDER] = {
      ports: { charge: { '1': { test: 'tests/contracts/charge.test.ts', hash: 'deadbeef' } } },
    };
    expect(await recordPortContractBaselines(graph, dir, lock)).toBe(false);
    expect(lock.nodes[PROVIDER].ports!.charge['1'].hash).toBe('deadbeef');
  });

  it('records a raised version ALONGSIDE the old one, so the old version keeps its contract', async () => {
    const dir = copyFixture();
    const lock = emptyLock();
    await recordPortContractBaselines(await loadGraph(dir), dir, lock);
    const firstHash = lock.nodes[PROVIDER].ports!.charge['1'].hash;

    appendFileSync(path.join(dir, CONTRACT_TEST), '\n// a tightened promise\n');
    const yaml = path.join(dir, '.yggdrasil', 'model', 'services', 'payments', 'yg-node.yaml');
    writeFileSync(yaml, readFileSync(yaml, 'utf-8').replace('version: 1', 'version: 2'));

    expect(await recordPortContractBaselines(await loadGraph(dir), dir, lock)).toBe(true);
    expect(Object.keys(lock.nodes[PROVIDER].ports!.charge).sort()).toEqual(['1', '2']);
    expect(lock.nodes[PROVIDER].ports!.charge['1'].hash).toBe(firstHash);
    expect(lock.nodes[PROVIDER].ports!.charge['2'].hash).not.toBe(firstHash);
  });

  it('reads a port that declares a test but no version at the implied version', async () => {
    const dir = copyFixture();
    const yaml = path.join(dir, '.yggdrasil', 'model', 'services', 'payments', 'yg-node.yaml');
    writeFileSync(yaml, readFileSync(yaml, 'utf-8').replace('    version: 1\n', ''));
    const lock = emptyLock();
    await recordPortContractBaselines(await loadGraph(dir), dir, lock);
    expect(Object.keys(lock.nodes[PROVIDER].ports!.charge)).toEqual([String(IMPLIED_PORT_VERSION)]);
    expect(await classify(dir, lock)).toEqual([]);
  });
});
