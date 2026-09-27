import type { Graph } from '../../model/graph.js';
import type { LockFile } from '../../model/lock.js';
import { computeSourceFingerprint } from '../../core/pairs.js';
import type { FreshnessMarkerInput } from '../contract.js';

/**
 * portal/api/freshness — the file-aware loop's per-node source freshness (the
 * honesty heartbeat), behind the portal facade.
 *
 * For every log_required node that carries a COMMITTED source baseline
 * (`lock.nodes[path].source`), compare its current mapped-source fingerprint — the
 * SAME fold `yg check` uses — against that baseline. `sourceChanged: true` when they
 * differ: the node's bytes moved since the baseline the log gate measures against, so
 * it reads "we don't know", never a pass.
 *
 * The baseline of a log_required node is written at positive closure, or it is one
 * recorded before the node's type turned log_required: every full fill records every
 * node's bytes whatever its verdicts say, so the first real change after the switch
 * owes an entry and the switch itself owes none (the owner's ruling). Such a baseline
 * attests no reading. It is used here anyway, and nothing needs its provenance: the
 * marker only ever pushes a node DOWN to unverified, never up. `sourceChanged: false`
 * is not a claim that the node is fresh or verified — the node's state still comes
 * from its pairs, so a node switched while a pair was refused or unverified reads
 * refused or unverified, exactly as `yg check` reports it. And when the bytes moved
 * since that baseline, `yg check`'s log gate asks for an entry over the same
 * comparison, so the marker and the gate agree.
 *
 * Honesty boundary — never over-fire: a node WITHOUT a committed baseline (`stored`
 * absent) is reported `sourceChanged: false`, and so is every node of a type
 * that is not log_required: the engine records its fingerprint on every full
 * fill whatever its verdicts say (a baseline for a later switch to
 * log_required), so there it attests no reading at all. A baseline's absence is
 * the normal case, not evidence of a change — the portal must not paint the whole repo
 * unverified from missing baselines. Such a node's freshness is already carried
 * honestly elsewhere: a node with reviewer pairs flips those pairs to `unverified`
 * on any input change (the pair-state path), and a no-rule node is already the
 * distinct, non-green `no-rule` state. This signal adds the ONE case neither
 * covers: a node that HAS a committed baseline whose source has since been edited
 * — exactly where a cached green must never re-render as a pass.
 *
 * ── What a baseline attests, exactly ───────────────────────────────────────
 * Not always "a reviewer read these bytes". Closure records the fingerprint when
 * every enforced rule the run was ASKED to settle is approved, and a run measured
 * against a change is asked for less: the rules that change is not accountable
 * for are deliberately left unbought (core/fill-closure.ts, condition (c)). Two
 * consequences, recorded here rather than papered over:
 *
 *   - a node that closed that way and is then edited stops raising this marker,
 *     because its baseline moved with it. Its unbought rule is still `unverified`
 *     and still drives the node's own state, so the panel does not read green —
 *     but the "bytes moved" signal specifically is absent for it.
 *   - at the extreme, a baseline can exist for a component no reviewer has ever
 *     read, if every one of its reviewer-judged rules has been outside every
 *     change so far. The same unverified pairs are what keeps it honest.
 *
 * Neither can manufacture a false green: a node in either state has at least one
 * unverified pair, and the pair-state path answers for it. What they cost is this
 * marker's precision on such a node, not the panel's honesty.
 *
 * A mapping-less node has an undefined fingerprint and is never marked changed.
 * Read-only; reuses the engine's own fingerprint function so the portal's freshness
 * can never diverge from the engine's source-change detection.
 */
export async function computePortalFreshness(
  graph: Graph,
  lock: LockFile,
): Promise<FreshnessMarkerInput[]> {
  const out: FreshnessMarkerInput[] = [];
  for (const [nodePath, node] of graph.nodes) {
    // Only a log_required node's baseline is written at closure; any other
    // node's is a bare record of its bytes, not of what a rule read.
    const logRequired = graph.architecture.node_types[node.meta.type]?.log_required ?? false;
    const stored = logRequired ? lock.nodes[nodePath]?.source : undefined;
    // No committed baseline → no honest claim of change (the common, non-log_required case).
    if (stored === undefined) {
      out.push({ nodePath, sourceChanged: false });
      continue;
    }
    let fingerprint: string | undefined;
    try {
      fingerprint = await computeSourceFingerprint(graph, nodePath);
    } catch {
      // An unreadable mapped file makes the fingerprint uncomputable. The node carries a
      // baseline (it once closed) but we can no longer confirm the bytes hold — never silently
      // fresh: report changed (it is already a blocking file-unreadable error elsewhere).
      out.push({ nodePath, sourceChanged: true });
      continue;
    }
    // Mapping-less node: no source to be fresh/stale about — never marked changed.
    if (fingerprint === undefined) {
      out.push({ nodePath, sourceChanged: false });
      continue;
    }
    out.push({ nodePath, sourceChanged: fingerprint !== stored });
  }
  return out;
}
