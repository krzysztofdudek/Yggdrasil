/** Collects result-bearing observations during one check.mjs run (spec §3.1).
 *  Keys/hashes come from core/pair-hash.ts — the frozen contract. */

import {
  observationKey,
  hashConfigObservation,
  hashReadObservation,
  hashListObservation,
  hashExistsObservation,
  hashNodeSetObservation,
  MISSING_OBSERVATION,
} from '../core/pair-hash.js';

export class ObservationRecorder {
  private readonly _entries = new Map<string, string>(); // key → hash (first-wins)
  private _tainted = false;

  /** Record a file-read observation. `bytes` is the raw content read. */
  recordRead(repoRelPosixPath: string, bytes: Buffer): void {
    this._record(observationKey('read', repoRelPosixPath), hashReadObservation(bytes));
  }

  /** Record a directory-listing observation. */
  recordList(repoRelPosixDir: string, entries: Array<{ name: string; kind: 'file' | 'dir' }>): void {
    this._record(observationKey('list', repoRelPosixDir), hashListObservation(entries));
  }

  /** Record an existence-probe observation (including negative probes where result === false). */
  recordExists(repoRelPosixPath: string, result: 'file' | 'dir' | false): void {
    this._record(observationKey('exists', repoRelPosixPath), hashExistsObservation(result));
  }

  /** Record a graph-node observation by hashing its yg-node.yaml bytes. */
  recordGraphNode(nodePath: string, ygNodeYamlBytes: Buffer): void {
    this._record(observationKey('graph', nodePath), hashReadObservation(ygNodeYamlBytes));
  }

  /**
   * Record an ABSENT file-read observation: the check attempted a read that threw
   * (the path passed the allow-check but the file was missing/unreadable at read
   * time). Folds MISSING_OBSERVATION under the same read:<path> key the verifier
   * re-observes — so if the check swallowed the throw and treated the file as
   * absent, a later successful read of that path changes the value ⇒ unverified
   * (spec §3.1, over-record: a throwing access is still an observation).
   */
  recordReadAbsent(repoRelPosixPath: string): void {
    this._record(observationKey('read', repoRelPosixPath), MISSING_OBSERVATION);
  }

  /**
   * Record an ABSENT directory-listing observation: the check attempted a list
   * that threw (path allow-checked but the dir was missing/unreadable at list
   * time). Folds MISSING_OBSERVATION under the list:<path> key — a later
   * successful listing changes the value ⇒ unverified (spec §3.1, over-record).
   */
  recordListAbsent(repoRelPosixDir: string): void {
    this._record(observationKey('list', repoRelPosixDir), MISSING_OBSERVATION);
  }

  /**
   * Record a NEGATIVE graph-node observation: the check looked up a node that
   * does not exist. Folds the MISSING_OBSERVATION token so the verifier's
   * re-observation (which reads that node's yg-node.yaml and also yields
   * MISSING_OBSERVATION when absent) reproduces it byte-for-byte — and creating
   * the node later changes the value ⇒ unverified (spec §3.1, over-record).
   */
  recordGraphNodeAbsent(nodePath: string): void {
    this._record(observationKey('graph', nodePath), MISSING_OBSERVATION);
  }

  /**
   * Record a child-set observation for `nodePath`: the SET of node ids returned
   * by ctx.graph.children(node). Folds membership only — adding/removing a child
   * invalidates; a content edit to an unchanged child rides its own graph:
   * observation (spec §3.1).
   */
  recordGraphChildren(nodePath: string, childIds: string[]): void {
    this._record(observationKey('graph-children', nodePath), hashNodeSetObservation(childIds));
  }

  /**
   * Record a by-type-set observation for `type`: the SET of node ids returned by
   * ctx.graph.nodesByType(type). Folds membership only — adding/removing a node
   * of that type invalidates (spec §3.1).
   */
  recordGraphNodesByType(type: string, nodeIds: string[]): void {
    this._record(observationKey('graph-bytype', type), hashNodeSetObservation(nodeIds));
  }

  /**
   * Record a flow-participant-set observation for `flowName`: the SET of declared
   * participant ids of the flow. Folds the flow's participant list (the flow
   * DEFINITION's membership) so adding/removing a participant in the flow file
   * invalidates the verdict, even when every still-present participant node is
   * unchanged (spec §3.1, flowParticipants minor).
   */
  recordFlowParticipants(flowName: string, participantIds: string[]): void {
    this._record(observationKey('graph-flow', flowName), hashNodeSetObservation(participantIds));
  }

  /**
   * Record a configuration-value observation: the rule read `ctx.config.<key>`
   * and got `value`.
   *
   * Recorded on the READ, never on the declaration, so a repository that adapts a
   * key no rule consults changes no verdict — and a repository that adapts one a
   * rule does consult sends exactly that rule's verdicts back for re-judging. A
   * key the rule asks for that the package never declared folds `undefined`, so
   * the key later appearing in a package is itself a change.
   */
  recordConfig(key: string, value: unknown): void {
    this._record(observationKey('config', key), hashConfigObservation(value));
  }

  /**
   * Returns a sorted, deduplicated array of [observationKey, observationHash] pairs.
   * Re-observing the same key with a different hash sets `tainted = true` and keeps
   * the first hash (first-observation-wins).
   */
  snapshot(): Array<[string, string]> {
    const result = [...this._entries.entries()];
    result.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return result;
  }

  /** True if the same path was observed with different content during this run. */
  get tainted(): boolean {
    return this._tainted;
  }

  private _record(key: string, hash: string): void {
    const existing = this._entries.get(key);
    if (existing === undefined) {
      this._entries.set(key, hash);
    } else if (existing !== hash) {
      // Same key, different hash: file changed mid-run — taint the run.
      this._tainted = true;
      // Keep first observation (do not overwrite).
    }
    // Same key, same hash: idempotent — no-op.
  }
}
