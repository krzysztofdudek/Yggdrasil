import type { Graph } from '../../model/graph.js';
import type { LockFile } from '../../model/lock.js';
import { computeSourceFingerprint } from '../../core/pairs.js';
import type { FreshnessMarkerInput } from '../contract.js';

/**
 * portal/api/freshness — the file-aware loop's per-node source freshness (the
 * honesty heartbeat), behind the portal facade.
 *
 * For every node that carries a COMMITTED source baseline (`lock.nodes[path].source`,
 * written at positive closure for a log_required node), compare its current
 * mapped-source fingerprint — the SAME fold `yg check` uses — against that baseline.
 * `sourceChanged: true` when they differ: the node's bytes changed since the reviewer
 * last saw them, so it reads "we don't know", never a pass.
 *
 * Honesty boundary — never over-fire: a node WITHOUT a committed baseline (`stored`
 * absent) is reported `sourceChanged: false`. Engine semantics record a source
 * fingerprint ONLY for log_required types, so a baseline's absence is the normal
 * case, not evidence of a change — the portal must not paint the whole repo
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
  for (const nodePath of graph.nodes.keys()) {
    const stored = lock.nodes[nodePath]?.source;
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
