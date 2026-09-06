/**
 * source/cli/src/core/checks/port-contracts.ts — the built-in port contract check.
 *
 * A port is a contract. A contract with no test is a declaration; a contract
 * whose test can change quietly makes every consumer's assumption unverifiable.
 * So a port may name the test that IS its contract, together with the version
 * consumers pin to — and this check holds the two together: at an unchanged
 * version the test file may only be what it was when that version was recorded.
 *
 * It is deterministic and free — a file hash against a recorded one, no reviewer,
 * no key — and it is BUILT IN rather than an aspect: it has no `check.mjs` to
 * sharpen, no status to demote, and no `yg-suppress` to waive it with, exactly
 * like the relation-conformance check beside it. What it does share with every
 * deterministic verdict is the record: the baseline lives in the committed lock,
 * and an approving run (including the free `--approve --only-deterministic`) is
 * what writes one.
 *
 * The three states, all reported through the ordinary check issue set:
 *   - no record at this version  → port-contract-unrecorded (an approving run fills it)
 *   - record disagrees            → port-contract-changed (the refusal this exists for)
 *   - test file cannot be read    → port-test-missing (fail closed; nothing is baselined)
 */

import path from 'node:path';
import type { Graph, PortDef } from '../../model/graph.js';
import type { LockFile } from '../../model/lock.js';
import type { CheckIssue } from '../check-contract.js';
import { hashFile } from '../../io/hash.js';
import { toPosixPath } from '../../utils/posix.js';

/**
 * The version a port declaring no `version:` is read at. A port that names a
 * contract test is protected from the first day; declaring `version: 2` later is
 * how its author says the contract moved.
 */
export const IMPLIED_PORT_VERSION = 1;

/** One port that declares a contract test, resolved to everything the check needs. */
interface ContractPort {
  nodePath: string;
  portName: string;
  version: number;
  /** Repo-relative POSIX path of the contract test. */
  test: string;
}

/** Every port in the graph that names a contract test, in a stable order. */
function collectContractPorts(graph: Graph): ContractPort[] {
  const out: ContractPort[] = [];
  for (const [nodePath, node] of graph.nodes) {
    const ports = node.meta.ports;
    if (!ports) continue;
    for (const portName of Object.keys(ports).sort()) {
      const port: PortDef = ports[portName];
      if (port.test === undefined) continue;
      out.push({
        nodePath,
        portName,
        version: port.version ?? IMPLIED_PORT_VERSION,
        test: toPosixPath(port.test),
      });
    }
  }
  return out.sort((a, b) =>
    a.nodePath < b.nodePath ? -1 : a.nodePath > b.nodePath ? 1 : a.portName < b.portName ? -1 : a.portName > b.portName ? 1 : 0,
  );
}

/** The recorded baseline for one (node, port, version), or undefined. */
function recordedAt(lock: LockFile, port: ContractPort): { test: string; hash: string } | undefined {
  return lock.nodes[port.nodePath]?.ports?.[port.portName]?.[String(port.version)];
}

/**
 * Hash the contract test, or return null when it cannot be read.
 *
 * `hashFile`'s line-ending normalization is deliberate and shared with every
 * other content hash in the lock: a contract test checked out with CRLF is the
 * same contract, and must not read as a change.
 */
async function hashContractTest(projectRoot: string, test: string): Promise<string | null> {
  try {
    return await hashFile(path.join(projectRoot, test));
  } catch {
    return null;
  }
}

/**
 * Report every port whose contract has moved, is unrecorded, or cannot be read.
 * Pure read — it never records anything; `recordPortContractBaselines` does that,
 * and only under `--approve`.
 */
export async function classifyPortContracts(
  graph: Graph,
  projectRoot: string,
  lock: LockFile,
  issues: CheckIssue[],
): Promise<void> {
  for (const port of collectContractPorts(graph)) {
    const where = `port '${port.portName}' on ${port.nodePath} (version ${port.version})`;
    const hash = await hashContractTest(projectRoot, port.test);

    if (hash === null) {
      issues.push({
        severity: 'error',
        code: 'port-test-missing',
        rule: 'port-test-missing',
        nodePath: port.nodePath,
        messageData: {
          what: `The contract test named by ${where} cannot be read: ${port.test}`,
          why: 'A port names the test that IS its contract, and consumers are held to that contract. A path that does not resolve leaves the contract with nothing behind it, and nothing can be baselined or compared — so this fails closed rather than passing over an unverifiable contract.',
          next: `Point ports.${port.portName}.test in .yggdrasil/model/${port.nodePath}/yg-node.yaml at the real contract test (a path relative to the repository root), or remove the field.`,
        },
      });
      continue;
    }

    const record = recordedAt(lock, port);
    if (!record) {
      issues.push({
        severity: 'error',
        code: 'port-contract-unrecorded',
        rule: 'port-contract-unrecorded',
        nodePath: port.nodePath,
        messageData: {
          what: `No contract baseline is recorded for ${where}.`,
          why: 'The contract at a version is held to the test file it was recorded with. Until that baseline exists there is nothing to hold it to, so a later change to the test would pass unnoticed.',
          next: 'Record it — free, no reviewer, no key: yg check --approve --only-deterministic',
        },
      });
      continue;
    }

    if (record.test !== port.test || record.hash !== hash) {
      const moved = record.test !== port.test
        ? `it now names ${port.test}, where version ${port.version} was recorded against ${record.test}`
        : `${port.test} has changed since version ${port.version} was recorded`;
      issues.push({
        severity: 'error',
        code: 'port-contract-changed',
        rule: 'port-contract-changed',
        nodePath: port.nodePath,
        messageData: {
          what: `The contract test behind ${where} no longer matches what that version was recorded with — ${moved}.`,
          why: `Consumers rely on this port at version ${port.version}; the test is the statement of what they may rely on. Letting it change under an unchanged version would move the contract without anyone being able to see that it moved.`,
          next: `If the contract really changed, raise ports.${port.portName}.version in .yggdrasil/model/${port.nodePath}/yg-node.yaml to ${port.version + 1}, record why with yg log add --node ${port.nodePath} --reason '<why the contract moved>', then run yg check --approve --only-deterministic. If it did not, restore ${port.test}.`,
        },
      });
    }
  }
}

/**
 * Record a baseline for every contract port that has none at its current
 * version. Called by an approving run only.
 *
 * It ADDS and never overwrites: an existing (port, version) record is the
 * contract, and re-baselining it on the spot is precisely the thing this check
 * exists to prevent. A version that was used before therefore keeps its own
 * record, so returning to it returns to the contract it named.
 *
 * Returns true when the lock was changed and needs persisting.
 */
export async function recordPortContractBaselines(
  graph: Graph,
  projectRoot: string,
  lock: LockFile,
): Promise<boolean> {
  let changed = false;
  for (const port of collectContractPorts(graph)) {
    if (recordedAt(lock, port)) continue;
    const hash = await hashContractTest(projectRoot, port.test);
    // Unreadable: classifyPortContracts already reports it as a blocking
    // failure. Recording nothing is the fail-closed half of that.
    if (hash === null) continue;
    const nodeEntry = (lock.nodes[port.nodePath] ??= {});
    const ports = (nodeEntry.ports ??= {});
    const versions = (ports[port.portName] ??= {});
    versions[String(port.version)] = { test: port.test, hash };
    changed = true;
  }
  return changed;
}
